/* app.js — VINMonad dApp (Swap • Dice • Lotto)
   - Chain: Monad (chainId 143)
   - Rate: 1 VIN = 100 MON (swap contract enforced)
   - Approve default: 1,000,000 VIN for Swap/Dice/Lotto
   - NOTE: VIN/USD price is handled in index.html (do not override here)
*/

(function () {
  "use strict";

  // -----------------------------
  // Constants
  // -----------------------------
  const CHAIN_ID_DEC = 143;
  const CHAIN_ID_HEX = "0x8f"; // 143
  const RPC_URL = "https://rpc.monad.xyz";
  const EXPLORER_URL = "https://monadvision.com";

  const ADDR_VIN = "0x038A2f1abe221d403834aa775669169Ef5eb120A";
  const ADDR_SWAP = "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB";
  const ADDR_DICE = "0xf2b1C0A522211949Ad2671b0F4bF92547d66ef3A";
  const ADDR_LOTTO = "0x17e945Bc2AeB9fcF9eb73DC4e4b8E2AE2962B525";

  const RATE_MON_PER_VIN = 100; // 1 VIN = 100 MON
  const APPROVE_VIN_AMOUNT = "1000000"; // 1,000,000 VIN

  // Minimal ABIs (only what we use)
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];

  const SWAP_ABI = [
    "function RATE() view returns (uint256)",
    "function swapVINtoMON(uint256 vinAmount)",
    "function swapMONtoVIN() payable",
  ];

  const DICE_ABI = [
    "event Played(address indexed player,uint256 amount,uint8 choice,uint8 diceResult,uint16 roll,bool won)",
    "function play(uint256 amount, uint8 choice, uint256 clientSeed)",
    "function MIN_BET() view returns (uint256)",
    "function MAX_BET() view returns (uint256)",
  ];

  const LOTTO_ABI = [
    "event Played(address indexed player,bool bet27,uint8[] numbers,uint256[] amounts,uint8[] drawn,uint8[] hits,uint256 totalBet,uint256 totalPayout)",
    "function play(bool bet27, uint8[] numbers, uint256[] amounts)",
    "function MIN_BET() view returns (uint256)",
  ];

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  function setText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function setDisabled(id, disabled) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  function shortAddr(a) {
    if (!a || typeof a !== "string" || a.length < 10) return "-";
    return a.slice(0, 6) + "..." + a.slice(-4);
  }

  function formatUnitsSafe(bn, decimals = 18, dp = 4) {
    try {
      const s = ethers.utils.formatUnits(bn, decimals);
      // clamp dp
      const n = Number(s);
      if (!Number.isFinite(n)) return s;
      return n.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: dp,
      });
    } catch (_) {
      return "-";
    }
  }

  function toWeiSafe(val, decimals = 18) {
    const s = (val ?? "").toString().trim();
    if (!s) return null;
    // basic sanitize
    if (!/^\d*\.?\d*$/.test(s)) return null;
    try {
      return ethers.utils.parseUnits(s, decimals);
    } catch (_) {
      return null;
    }
  }

  function randomUint32() {
    try {
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      return arr[0];
    } catch (_) {
      return Math.floor(Math.random() * 2 ** 32);
    }
  }

  function txLink(hash) {
    if (!hash) return "-";
    return `${EXPLORER_URL}/tx/${hash}`;
  }

  // -----------------------------
  // State
  // -----------------------------
  let provider = null;
  let signer = null;
  let account = null;

  let vinRead = null;
  let swapRead = null;
  let diceRead = null;
  let lottoRead = null;

  let vinWrite = null;
  let swapWrite = null;
  let diceWrite = null;
  let lottoWrite = null;

  let vinDecimals = 18;

  // UI mode
  let swapMode = "VIN_TO_MON"; // or "MON_TO_VIN"
  let diceChoice = 0; // 0 EVEN, 1 ODD
  let lottoBet27 = false; // false BetOne, true Bet27

  // -----------------------------
  // Screens / Navigation
  // -----------------------------
  const SCREENS = [
    { nav: "navHome", screen: "home-screen" },
    { nav: "navSwap", screen: "swap-screen" },
    { nav: "navDice", screen: "dice-screen" },
    { nav: "navLotto", screen: "lotto-screen" },
  ];

  function showScreen(screenId) {
    for (const s of SCREENS) {
      const navBtn = $(s.nav);
      const section = $(s.screen);
      if (section) {
        section.classList.toggle("screen-active", s.screen === screenId);
      }
      if (navBtn) {
        navBtn.classList.toggle("active", s.screen === screenId);
      }
    }
  }

  // -----------------------------
  // Chain / Wallet
  // -----------------------------
  async function ensureMonadChain() {
    if (!window.ethereum) throw new Error("No wallet");

    const eth = window.ethereum;

    // Some wallets expose chainId hex
    const currentChainId = await eth.request({ method: "eth_chainId" });
    if (currentChainId === CHAIN_ID_HEX) return;

    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (e) {
      // If chain not added, add it
      if (e && (e.code === 4902 || e.data?.originalError?.code === 4902)) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_ID_HEX,
              chainName: "Monad",
              rpcUrls: [RPC_URL],
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              blockExplorerUrls: [EXPLORER_URL],
            },
          ],
        });
      } else {
        throw e;
      }
    }
  }

  function setDisconnectedUI() {
    account = null;
    signer = null;

    setText("walletShort", "Not connected");
    setText("networkName", "Not connected");
    const dot = $("networkDot");
    if (dot) {
      dot.classList.remove("dot-connected");
      dot.classList.add("dot-disconnected");
    }

    setText("homeVinBalance", "-");
    setText("homeMonBalance", "-");

    // Swap wallet panel
    setText("swapWallet", "Not connected");
    setText("swapVinBalance", "-");
    setText("swapMonBalance", "-");
    setText("swapAllowance", "-");
    setText("swapVinPool", "Loading...");
    setText("swapMonPool", "Loading...");
    setText("swapFromBalance", "Balance: -");
    setText("swapToBalance", "Balance: -");

    // Dice wallet panel
    setText("diceWallet", "Not connected");
    setText("diceVinBalance", "-");
    setText("diceMonBalance", "-");
    setText("diceAllowance", "-");
    setText("diceBankroll", "Loading...");
    setText("diceMinValue", "-");
    setText("diceMaxValue", "-");

    // Lotto wallet panel
    setText("lottoWallet", "Not connected");
    setText("lottoVinBalance", "-");
    setText("lottoMonBalance", "-");
    setText("lottoAllowance", "-");
    setText("lottoPoolVin", "Loading...");

    // Buttons
    setText("swapStatus", "Waiting for your action...");
    setText("diceStatus", "Waiting for your action...");
    setText("lottoStatus", "Waiting for your action...");
    setText("lottoYourBet", "No bet yet");
    setText("lottoResult", "No result yet");
    setText("lottoWinLoss", "No win/loss yet");
    setText("lottoTx", "-");
    setText("lottoDraw", "-");

    // Disable actions until connected
    setDisabled("swapApproveBtn", true);
    setDisabled("swapBtn", true);
    setDisabled("diceApproveBtn", true);
    setDisabled("dicePlayBtn", true);
    setDisabled("lottoApproveBtn", true);
    setDisabled("lottoPlayBtn", true);
  }

  async function connectWallet() {
    if (!window.ethereum) {
      alert("No wallet detected. Please install MetaMask or a compatible wallet.");
      return;
    }

    try {
      await ensureMonadChain();

      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      const accounts = await provider.send("eth_requestAccounts", []);
      account = accounts && accounts[0] ? ethers.utils.getAddress(accounts[0]) : null;

      if (!account) throw new Error("No account");

      signer = provider.getSigner();

      // Read contracts
      vinRead = new ethers.Contract(ADDR_VIN, ERC20_ABI, provider);
      swapRead = new ethers.Contract(ADDR_SWAP, SWAP_ABI, provider);
      diceRead = new ethers.Contract(ADDR_DICE, DICE_ABI, provider);
      lottoRead = new ethers.Contract(ADDR_LOTTO, LOTTO_ABI, provider);

      // Write contracts
      vinWrite = vinRead.connect(signer);
      swapWrite = swapRead.connect(signer);
      diceWrite = diceRead.connect(signer);
      lottoWrite = lottoRead.connect(signer);

      // Decimals
      try {
        vinDecimals = await vinRead.decimals();
      } catch (_) {
        vinDecimals = 18;
      }

      // Network indicator
      setText("networkName", "Monad");
      const dot = $("networkDot");
      if (dot) {
        dot.classList.remove("dot-disconnected");
        dot.classList.add("dot-connected");
      }

      // Wallet labels
      setText("walletShort", shortAddr(account));
      setText("swapWallet", shortAddr(account));
      setText("diceWallet", shortAddr(account));
      setText("lottoWallet", shortAddr(account));

      // Enable action buttons
      setDisabled("swapBtn", false);
      setDisabled("dicePlayBtn", false);
      setDisabled("lottoPlayBtn", false);

      await refreshAll();
    } catch (e) {
      console.error(e);
      alert("Failed to connect wallet. Make sure Monad network is selected in your wallet.");
    }
  }

  async function refreshAll() {
    await Promise.allSettled([
      refreshBalances(),
      refreshPools(),
      refreshAllowances(),
      refreshDiceLimits(),
      refreshSwapUIBalances(),
      refreshLottoTotal(),
    ]);
  }

  async function refreshBalances() {
    if (!provider || !account) return;

    const monBal = await provider.getBalance(account);
    const vinBal = await vinRead.balanceOf(account);

    const monTxt = formatUnitsSafe(monBal, 18, 4) + " MON";
    const vinTxt = formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN";

    setText("homeMonBalance", monTxt);
    setText("homeVinBalance", vinTxt);

    setText("swapMonBalance", monTxt);
    setText("swapVinBalance", vinTxt);

    setText("diceMonBalance", monTxt);
    setText("diceVinBalance", vinTxt);

    setText("lottoMonBalance", monTxt);
    setText("lottoVinBalance", vinTxt);
  }

  async function refreshPools() {
    if (!provider) return;

    const [swapVin, swapMon, diceVin, lottoVin] = await Promise.all([
      vinRead.balanceOf(ADDR_SWAP),
      provider.getBalance(ADDR_SWAP),
      vinRead.balanceOf(ADDR_DICE),
      vinRead.balanceOf(ADDR_LOTTO),
    ]);

    setText("swapVinPool", formatUnitsSafe(swapVin, vinDecimals, 4) + " VIN");
    setText("swapMonPool", formatUnitsSafe(swapMon, 18, 4) + " MON");

    setText("diceBankroll", formatUnitsSafe(diceVin, vinDecimals, 4) + " VIN");
    setText("lottoPoolVin", formatUnitsSafe(lottoVin, vinDecimals, 4) + " VIN");
  }

  async function refreshAllowances() {
    if (!account || !vinRead) return;

    const [aSwap, aDice, aLotto] = await Promise.all([
      vinRead.allowance(account, ADDR_SWAP),
      vinRead.allowance(account, ADDR_DICE),
      vinRead.allowance(account, ADDR_LOTTO),
    ]);

    setText("swapAllowance", formatUnitsSafe(aSwap, vinDecimals, 4) + " VIN");
    setText("diceAllowance", formatUnitsSafe(aDice, vinDecimals, 4) + " VIN");
    setText("lottoAllowance", formatUnitsSafe(aLotto, vinDecimals, 4) + " VIN");

    // Enable approve buttons only when connected
    setDisabled("swapApproveBtn", false);
    setDisabled("diceApproveBtn", false);
    setDisabled("lottoApproveBtn", false);
  }

  async function refreshDiceLimits() {
    if (!diceRead) return;
    try {
      const [minB, maxB] = await Promise.all([diceRead.MIN_BET(), diceRead.MAX_BET()]);
      setText("diceMinValue", formatUnitsSafe(minB, vinDecimals, 6));
      setText("diceMaxValue", formatUnitsSafe(maxB, vinDecimals, 6));
    } catch (_) {
      setText("diceMinValue", "1");
      setText("diceMaxValue", "50");
    }
  }

  // -----------------------------
  // Swap UI logic
  // -----------------------------
  function setSwapMode(mode) {
    swapMode = mode;

    const tabA = $("tabVinToMon");
    const tabB = $("tabMonToVin");
    if (tabA && tabB) {
      tabA.classList.toggle("active", mode === "VIN_TO_MON");
      tabB.classList.toggle("active", mode === "MON_TO_VIN");
    }

    // Token tags
    if (mode === "VIN_TO_MON") {
      setText("swapFromToken", "VIN");
      setText("swapToToken", "MON");
      setText("swapRateLine", "Rate: 1 VIN = 100 MON (fixed while pool has liquidity)");
      setText("swapStatus", "Waiting for your action...");
      setText("swapApproveBtn", "Approve VIN");
      setDisabled("swapApproveBtn", !account);
    } else {
      setText("swapFromToken", "MON");
      setText("swapToToken", "VIN");
      setText("swapRateLine", "Rate: 100 MON = 1 VIN (fixed while pool has liquidity)");
      setText("swapStatus", "Waiting for your action...");
      // No approve needed
      setDisabled("swapApproveBtn", true);
    }

    // Reset amounts
    const from = $("swapFromAmount");
    const to = $("swapToAmount");
    if (from) from.value = "";
    if (to) to.value = "";
    refreshSwapUIBalances().catch(() => {});
  }

  async function refreshSwapUIBalances() {
    if (!provider || !account) {
      setText("swapFromBalance", "Balance: -");
      setText("swapToBalance", "Balance: -");
      setText("swapFromBalance", "Balance: -");
      setText("swapToBalance", "Balance: -");
      return;
    }

    const monBal = await provider.getBalance(account);
    const vinBal = await vinRead.balanceOf(account);

    if (swapMode === "VIN_TO_MON") {
      setText("swapFromBalance", "Balance: " + formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN");
      setText("swapToBalance", "Balance: " + formatUnitsSafe(monBal, 18, 4) + " MON");
    } else {
      setText("swapFromBalance", "Balance: " + formatUnitsSafe(monBal, 18, 4) + " MON");
      setText("swapToBalance", "Balance: " + formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN");
    }
  }

  function recalcSwapTo() {
    const fromEl = $("swapFromAmount");
    const toEl = $("swapToAmount");
    if (!fromEl || !toEl) return;

    const s = (fromEl.value || "").trim();
    if (!s || !/^\d*\.?\d*$/.test(s)) {
      toEl.value = "";
      return;
    }
    const x = Number(s);
    if (!Number.isFinite(x)) {
      toEl.value = "";
      return;
    }
    let y = 0;
    if (swapMode === "VIN_TO_MON") {
      y = x * RATE_MON_PER_VIN;
    } else {
      y = x / RATE_MON_PER_VIN;
    }
    toEl.value = y ? String(y) : "0";
  }

  async function swapSetMax() {
    if (!provider || !account) return;
    const fromEl = $("swapFromAmount");
    if (!fromEl) return;

    if (swapMode === "VIN_TO_MON") {
      const vinBal = await vinRead.balanceOf(account);
      fromEl.value = ethers.utils.formatUnits(vinBal, vinDecimals);
    } else {
      const monBal = await provider.getBalance(account);
      // Keep small buffer for gas
      const buffer = ethers.utils.parseEther("0.005");
      const safe = monBal.gt(buffer) ? monBal.sub(buffer) : ethers.BigNumber.from(0);
      fromEl.value = ethers.utils.formatUnits(safe, 18);
    }
    recalcSwapTo();
  }

  async function approveVIN(spender, contextLabel) {
    if (!vinWrite || !account) {
      alert("Connect wallet first.");
      return;
    }
    try {
      const amt = ethers.utils.parseUnits(APPROVE_VIN_AMOUNT, vinDecimals);
      const label = contextLabel || "Approval";

      setText("swapStatus", label + ": Waiting for confirmation...");
      setText("diceStatus", label + ": Waiting for confirmation...");
      setText("lottoStatus", label + ": Waiting for confirmation...");

      const tx = await vinWrite.approve(spender, amt);
      // show status in the relevant section if possible
      if (spender.toLowerCase() === ADDR_SWAP.toLowerCase()) {
        setText("swapStatus", "Approval sent: " + tx.hash);
      } else if (spender.toLowerCase() === ADDR_DICE.toLowerCase()) {
        setText("diceStatus", "Approval sent: " + tx.hash);
      } else if (spender.toLowerCase() === ADDR_LOTTO.toLowerCase()) {
        setText("lottoStatus", "Approval sent: " + tx.hash);
      }

      await tx.wait();
      if (spender.toLowerCase() === ADDR_SWAP.toLowerCase()) {
        setText("swapStatus", "Approved ✓");
      } else if (spender.toLowerCase() === ADDR_DICE.toLowerCase()) {
        setText("diceStatus", "Approved ✓");
      } else if (spender.toLowerCase() === ADDR_LOTTO.toLowerCase()) {
        setText("lottoStatus", "Approved ✓");
      }

      await refreshAllowances();
    } catch (e) {
      console.error(e);
      if (spender.toLowerCase() === ADDR_SWAP.toLowerCase()) {
        setText("swapStatus", "Approval failed.");
      } else if (spender.toLowerCase() === ADDR_DICE.toLowerCase()) {
        setText("diceStatus", "Approval failed.");
      } else if (spender.toLowerCase() === ADDR_LOTTO.toLowerCase()) {
        setText("lottoStatus", "Approval failed.");
      }
      alert("Approval failed or rejected.");
    }
  }

  async function doSwap() {
    if (!swapWrite || !provider || !account) {
      alert("Connect wallet first.");
      return;
    }

    const fromEl = $("swapFromAmount");
    if (!fromEl) return;

    const amountBN = toWeiSafe(fromEl.value, swapMode === "VIN_TO_MON" ? vinDecimals : 18);
    if (!amountBN || amountBN.lte(0)) {
      setText("swapStatus", "Enter an amount.");
      return;
    }

    try {
      setText("swapStatus", "Preparing transaction...");

      if (swapMode === "VIN_TO_MON") {
        const allowance = await vinRead.allowance(account, ADDR_SWAP);
        if (allowance.lt(amountBN)) {
          setText("swapStatus", "Allowance too low. Please approve VIN first.");
          return;
        }
        const tx = await swapWrite.swapVINtoMON(amountBN);
        setText("swapStatus", "Swap sent: " + tx.hash);
        await tx.wait();
        setText("swapStatus", "Swap confirmed ✓");
      } else {
        const tx = await swapWrite.swapMONtoVIN({ value: amountBN });
        setText("swapStatus", "Swap sent: " + tx.hash);
        await tx.wait();
        setText("swapStatus", "Swap confirmed ✓");
      }

      // Refresh UI
      await Promise.allSettled([refreshBalances(), refreshPools(), refreshAllowances(), refreshSwapUIBalances()]);
      recalcSwapTo();
    } catch (e) {
      console.error(e);
      setText("swapStatus", "Swap failed.");
      alert("Swap failed or rejected.");
    }
  }

  // -----------------------------
  // Dice UI logic
  // -----------------------------
  function setDiceChoice(choice) {
    diceChoice = choice; // 0 even, 1 odd
    const evenBtn = $("guessEven");
    const oddBtn = $("guessOdd");
    if (evenBtn) evenBtn.classList.toggle("active", choice === 0);
    if (oddBtn) oddBtn.classList.toggle("active", choice === 1);
  }

  function getDiceVisualColors(isEven) {
    // Even: 3 outcomes (4W, 4R, 2W2R)
    const evenResults = [
      ["white", "white", "white", "white"],
      ["red", "red", "red", "red"],
      ["white", "white", "red", "red"],
    ];
    // Odd: 2 outcomes (1R3W) or (3R1W)
    const oddResults = [
      ["red", "white", "white", "white"],
      ["red", "red", "red", "white"],
    ];

    const arr = isEven ? evenResults : oddResults;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function applyDiceVisual(isEven) {
    const coins = document.querySelectorAll(".dice-coin");
    const colors = getDiceVisualColors(isEven);
    colors.forEach((c, i) => {
      const el = coins[i];
      if (!el) return;
      el.classList.remove("dice-coin-white", "dice-coin-red");
      el.classList.add(c === "red" ? "dice-coin-red" : "dice-coin-white");
    });
  }

  async function diceSetMax() {
    if (!provider || !account) return;
    const vinBal = await vinRead.balanceOf(account);
    const el = $("diceBetAmount");
    if (el) {
      el.value = ethers.utils.formatUnits(vinBal, vinDecimals);
    }
  }

  async function doDicePlay() {
    if (!diceWrite || !provider || !account) {
      alert("Connect wallet first.");
      return;
    }

    const betEl = $("diceBetAmount");
    const amountBN = toWeiSafe(betEl ? betEl.value : "", vinDecimals);
    if (!amountBN || amountBN.lte(0)) {
      setText("diceStatus", "Enter a bet amount.");
      return;
    }

    try {
      // ensure allowance
      const allowance = await vinRead.allowance(account, ADDR_DICE);
      if (allowance.lt(amountBN)) {
        setText("diceStatus", "Allowance too low. Please approve VIN first.");
        return;
      }

      setText("diceStatus", "Waiting for confirmation...");
      setText("diceResultText", "Rolling...");

      const clientSeed = randomUint32();

      const tx = await diceWrite.play(amountBN, diceChoice, clientSeed);
      setText("diceStatus", "Transaction sent: " + tx.hash);

      const receipt = await tx.wait();

      // Parse event
      let played = null;
      try {
        for (const log of receipt.logs) {
          try {
            const parsed = diceRead.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              played = parsed.args;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}

      if (played) {
        const won = !!played.won;
        const diceResult = Number(played.diceResult); // 0 even / 1 odd
        const roll = Number(played.roll);

        const outcomeTxt = diceResult === 0 ? "EVEN" : "ODD";
        const winLossTxt = won ? "WIN" : "LOSE";

        // Visual should match outcome (not the guess)
        applyDiceVisual(diceResult === 0);

        setText("diceResultText", `${outcomeTxt} • Roll: ${roll} • ${winLossTxt}`);

        setText("diceLastOutcome", outcomeTxt);
        setText("diceLastWinLoss", winLossTxt);
        // payout: if won -> 2x bet, else 0
        const payout = won ? amountBN.mul(2) : ethers.BigNumber.from(0);
        setText("diceLastPayout", formatUnitsSafe(payout, vinDecimals, 4) + " VIN");
        setHTML("diceLastTx", `<a href="${txLink(tx.hash)}" target="_blank" rel="noopener noreferrer">${shortAddr(tx.hash)}</a>`);
      } else {
        // fallback
        applyDiceVisual(diceChoice === 0);
        setText("diceResultText", "Done.");
        setHTML("diceLastTx", `<a href="${txLink(tx.hash)}" target="_blank" rel="noopener noreferrer">${shortAddr(tx.hash)}</a>`);
      }

      setText("diceStatus", "Done ✓");

      await Promise.allSettled([refreshBalances(), refreshPools(), refreshAllowances()]);
    } catch (e) {
      console.error(e);
      setText("diceStatus", "Play failed.");
      setText("diceResultText", "-");
      alert("Dice play failed or rejected.");
    }
  }

  // -----------------------------
  // Lotto UI logic
  // -----------------------------
  function setLottoMode(isBet27) {
    lottoBet27 = !!isBet27;
    const tabA = $("tabBetOne");
    const tabB = $("tabBet27");
    if (tabA && tabB) {
      tabA.classList.toggle("active", !lottoBet27);
      tabB.classList.toggle("active", lottoBet27);
    }
    setText("lottoStatus", "Waiting for your action...");
  }

  function getLottoRowsContainer() {
    return $("lottoRows");
  }

  function getRowEls() {
    const c = getLottoRowsContainer();
    if (!c) return [];
    return Array.from(c.querySelectorAll(".lotto-row"));
  }

  function clamp2Digits(val) {
    const s = (val ?? "").toString().replace(/[^\d]/g, "").slice(0, 2);
    return s;
  }

  function readBetsFromUI() {
    const rows = getRowEls();
    const numbers = [];
    const amounts = [];
    for (let i = 0; i < rows.length; i++) {
      const numEl = rows[i].querySelector(".lotto-number");
      const betEl = rows[i].querySelector(".lotto-bet");

      const numRaw = (numEl ? numEl.value : "").trim();
      const betRaw = (betEl ? betEl.value : "").trim();

      if (!numRaw && !betRaw) continue;

      if (!/^\d{1,2}$/.test(numRaw)) return { ok: false, reason: "Invalid number. Use 00–99.", numbers: [], amounts: [] };
      const n = Number(numRaw);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { ok: false, reason: "Invalid number. Use 00–99.", numbers: [], amounts: [] };

      const amtBN = toWeiSafe(betRaw, vinDecimals);
      if (!amtBN || amtBN.lt(ethers.utils.parseUnits("1", vinDecimals))) {
        return { ok: false, reason: "Each bet amount must be ≥ 1 VIN.", numbers: [], amounts: [] };
      }

      numbers.push(n);
      amounts.push(amtBN);
    }

    if (numbers.length === 0) return { ok: false, reason: "No bets yet.", numbers: [], amounts: [] };
    return { ok: true, reason: "", numbers, amounts };
  }

  function formatTwoDigits(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "--";
    return String(x).padStart(2, "0");
  }

  async function refreshLottoTotal() {
    const rows = getRowEls();
    let total = 0;
    for (const r of rows) {
      const betEl = r.querySelector(".lotto-bet");
      const bn = toWeiSafe(betEl ? betEl.value : "", vinDecimals);
      if (bn && bn.gt(0)) total += Number(ethers.utils.formatUnits(bn, vinDecimals));
    }
    const totalEl = $("lottoTotalBet");
    if (totalEl) totalEl.textContent = Number.isFinite(total) ? total.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "0";
  }

  function rebuildRowIds() {
    const rows = getRowEls();
    rows.forEach((row, idx) => {
      row.setAttribute("data-row", String(idx));
      const num = row.querySelector(".lotto-number");
      const bet = row.querySelector(".lotto-bet");
      if (num) num.id = `lottoNumber${idx}`;
      if (bet) bet.id = `lottoBet${idx}`;
    });

    // Remove button disabled if only 1 row
    const rm = $("lottoRemoveRowBtn");
    if (rm) rm.disabled = rows.length <= 1;
  }

  function addLottoRow() {
    const c = getLottoRowsContainer();
    if (!c) return;

    const idx = getRowEls().length;
    const row = document.createElement("div");
    row.className = "lotto-row";
    row.setAttribute("data-row", String(idx));

    row.innerHTML = `
      <div class="lotto-col">
        <div class="swap-label-row">
          <span class="swap-label">Number (00–99)</span>
          <span class="swap-balance">Two digits</span>
        </div>
        <input class="swap-input lotto-number" id="lottoNumber${idx}" type="text" inputmode="numeric" maxlength="2" placeholder="12" autocomplete="off"/>
      </div>

      <div class="lotto-col">
        <div class="swap-label-row">
          <span class="swap-label">Bet Amount (VIN)</span>
          <span class="swap-balance">≥ 1</span>
        </div>
        <input class="swap-input lotto-bet" id="lottoBet${idx}" type="text" inputmode="decimal" placeholder="1" value="1" autocomplete="off"/>
      </div>
    `;

    c.appendChild(row);
    bindLottoRowInputs(row);
    rebuildRowIds();
    refreshLottoTotal().catch(() => {});
  }

  function removeLottoRow() {
    const rows = getRowEls();
    if (rows.length <= 1) return;
    const last = rows[rows.length - 1];
    last.remove();
    rebuildRowIds();
    refreshLottoTotal().catch(() => {});
  }

  function bindLottoRowInputs(scopeEl) {
    const numEl = scopeEl.querySelector(".lotto-number");
    const betEl = scopeEl.querySelector(".lotto-bet");
    if (numEl) {
      numEl.addEventListener("input", () => {
        numEl.value = clamp2Digits(numEl.value);
        refreshLottoTotal().catch(() => {});
      });
    }
    if (betEl) {
      betEl.addEventListener("input", () => refreshLottoTotal().catch(() => {}));
    }
  }

  function bindAllLottoInputs() {
    const rows = getRowEls();
    for (const r of rows) bindLottoRowInputs(r);
    rebuildRowIds();
  }

  function scaleAllBets(factor) {
    const rows = getRowEls();
    for (const r of rows) {
      const betEl = r.querySelector(".lotto-bet");
      if (!betEl) continue;
      const v = Number((betEl.value || "").trim());
      if (!Number.isFinite(v) || v <= 0) continue;
      const nv = v * factor;
      // Keep >= 1
      betEl.value = String(Math.max(1, Math.round(nv * 10000) / 10000));
    }
    refreshLottoTotal().catch(() => {});
  }

  function clearLottoRows() {
    const c = getLottoRowsContainer();
    if (!c) return;
    c.innerHTML = "";
    // Create default row
    const row = document.createElement("div");
    row.className = "lotto-row";
    row.setAttribute("data-row", "0");
    row.innerHTML = `
      <div class="lotto-col">
        <div class="swap-label-row">
          <span class="swap-label">Number (00–99)</span>
          <span class="swap-balance">Two digits</span>
        </div>
        <input class="swap-input lotto-number" id="lottoNumber0" type="text" inputmode="numeric" maxlength="2" placeholder="12" autocomplete="off"/>
      </div>

      <div class="lotto-col">
        <div class="swap-label-row">
          <span class="swap-label">Bet Amount (VIN)</span>
          <span class="swap-balance">≥ 1</span>
        </div>
        <input class="swap-input lotto-bet" id="lottoBet0" type="text" inputmode="decimal" placeholder="1" value="1" autocomplete="off"/>
      </div>
    `;
    c.appendChild(row);
    bindLottoRowInputs(row);
    rebuildRowIds();
    refreshLottoTotal().catch(() => {});
  }

  async function doLottoPlay() {
    if (!lottoWrite || !provider || !account) {
      alert("Connect wallet first.");
      return;
    }

    const bet = readBetsFromUI();
    if (!bet.ok) {
      setText("lottoStatus", bet.reason || "Invalid bets.");
      return;
    }

    // check allowance for total bet
    const totalBetBN = bet.amounts.reduce((acc, x) => acc.add(x), ethers.BigNumber.from(0));

    try {
      const allowance = await vinRead.allowance(account, ADDR_LOTTO);
      if (allowance.lt(totalBetBN)) {
        setText("lottoStatus", "Allowance too low. Please approve VIN first.");
        return;
      }

      setText("lottoStatus", "Waiting for confirmation...");
      setText("lottoYourBet", "Submitting...");
      setText("lottoResult", "Pending...");
      setText("lottoWinLoss", "Pending...");
      setText("lottoTx", "-");
      setText("lottoDraw", "-");

      const tx = await lottoWrite.play(
        lottoBet27,
        bet.numbers,
        bet.amounts
      );

      setHTML("lottoTx", `<a href="${txLink(tx.hash)}" target="_blank" rel="noopener noreferrer">${shortAddr(tx.hash)}</a>`);
      setText("lottoStatus", "Transaction sent: " + tx.hash);

      const receipt = await tx.wait();

      // Parse Played event
      let played = null;
      try {
        for (const log of receipt.logs) {
          try {
            const parsed = lottoRead.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              played = parsed.args;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}

      if (played) {
        const drawn = (played.drawn || []).map((x) => Number(x));
        const hits = (played.hits || []).map((x) => Number(x));
        const totalBet = played.totalBet;
        const totalPayout = played.totalPayout;

        // Your bet summary
        const betPairs = bet.numbers.map((n, i) => {
          const amt = bet.amounts[i];
          return `${formatTwoDigits(n)} (${formatUnitsSafe(amt, vinDecimals, 4)} VIN)`;
        });

        setText("lottoYourBet", betPairs.join(", "));

        // Drawn numbers
        const drawnTxt = drawn.map(formatTwoDigits).join(" ");
        setText("lottoDraw", drawnTxt || "-");

        // Result & win/loss
        const betStr = formatUnitsSafe(totalBet, vinDecimals, 4) + " VIN";
        const payoutStr = formatUnitsSafe(totalPayout, vinDecimals, 4) + " VIN";
        setText("lottoResult", `Bet: ${betStr} • Payout: ${payoutStr}`);

        const won = totalPayout.gt(0);
        setText("lottoWinLoss", won ? "WIN" : "LOSE");

        // Small hit detail (Bet27 shows hits count per row; BetOne show 0/1 hit)
        if (Array.isArray(hits) && hits.length) {
          // display hits per row in status line
          const hitLine = hits
            .map((h, i) => `${formatTwoDigits(bet.numbers[i])}: ${h}`)
            .join(" | ");
          setText("lottoStatus", (lottoBet27 ? "Hits: " : "Match: ") + hitLine);
        } else {
          setText("lottoStatus", "Done ✓");
        }
      } else {
        setText("lottoStatus", "Done ✓");
        setText("lottoResult", "Done.");
      }

      await Promise.allSettled([refreshBalances(), refreshPools(), refreshAllowances()]);
    } catch (e) {
      console.error(e);
      setText("lottoStatus", "Bet failed.");
      alert("Lotto bet failed or rejected.");
    }
  }

  // -----------------------------
  // Bind UI events
  // -----------------------------
  function bindEvents() {
    // Top nav
    const navBrand = $("navBrand");
    if (navBrand) navBrand.addEventListener("click", () => showScreen("home-screen"));

    const connectBtn = $("connectBtn");
    if (connectBtn) connectBtn.addEventListener("click", connectWallet);

    for (const s of SCREENS) {
      const btn = $(s.nav);
      if (btn) btn.addEventListener("click", () => showScreen(s.screen));
    }

    // Home actions
    const goSwap = $("goToSwap");
    const goDice = $("goToDice");
    const goLotto = $("goToLotto");
    if (goSwap) goSwap.addEventListener("click", () => showScreen("swap-screen"));
    if (goDice) goDice.addEventListener("click", () => showScreen("dice-screen"));
    if (goLotto) goLotto.addEventListener("click", () => showScreen("lotto-screen"));

    const refreshBtn = $("refreshBalancesBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", () => refreshAll().catch(() => {}));

    // Swap
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    if (tabVinToMon) tabVinToMon.addEventListener("click", () => setSwapMode("VIN_TO_MON"));
    if (tabMonToVin) tabMonToVin.addEventListener("click", () => setSwapMode("MON_TO_VIN"));

    const swapFrom = $("swapFromAmount");
    if (swapFrom) swapFrom.addEventListener("input", recalcSwapTo);

    const swapMax = $("swapMaxBtn");
    if (swapMax) swapMax.addEventListener("click", () => swapSetMax().catch(() => {}));

    const swapApprove = $("swapApproveBtn");
    if (swapApprove) swapApprove.addEventListener("click", () => approveVIN(ADDR_SWAP, "Swap approval"));

    const swapBtn = $("swapBtn");
    if (swapBtn) swapBtn.addEventListener("click", () => doSwap().catch(() => {}));

    // Dice
    const evenBtn = $("guessEven");
    const oddBtn = $("guessOdd");
    if (evenBtn) evenBtn.addEventListener("click", () => setDiceChoice(0));
    if (oddBtn) oddBtn.addEventListener("click", () => setDiceChoice(1));

    const diceMax = $("diceMaxBtn");
    if (diceMax) diceMax.addEventListener("click", () => diceSetMax().catch(() => {}));

    const diceApprove = $("diceApproveBtn");
    if (diceApprove) diceApprove.addEventListener("click", () => approveVIN(ADDR_DICE, "Dice approval"));

    const dicePlay = $("dicePlayBtn");
    if (dicePlay) dicePlay.addEventListener("click", () => doDicePlay().catch(() => {}));

    // Lotto
    const tabBetOne = $("tabBetOne");
    const tabBet27 = $("tabBet27");
    if (tabBetOne) tabBetOne.addEventListener("click", () => setLottoMode(false));
    if (tabBet27) tabBet27.addEventListener("click", () => setLottoMode(true));

    const addRow = $("lottoAddRowBtn");
    const rmRow = $("lottoRemoveRowBtn");
    if (addRow) addRow.addEventListener("click", addLottoRow);
    if (rmRow) rmRow.addEventListener("click", removeLottoRow);

    const half = $("lottoHalfBtn");
    const dbl = $("lottoDoubleBtn");
    const clr = $("lottoClearBtn");
    if (half) half.addEventListener("click", () => scaleAllBets(0.5));
    if (dbl) dbl.addEventListener("click", () => scaleAllBets(2));
    if (clr) clr.addEventListener("click", clearLottoRows);

    const lottoApprove = $("lottoApproveBtn");
    if (lottoApprove) lottoApprove.addEventListener("click", () => approveVIN(ADDR_LOTTO, "Lotto approval"));

    const lottoPlay = $("lottoPlayBtn");
    if (lottoPlay) lottoPlay.addEventListener("click", () => doLottoPlay().catch(() => {}));

    // Initial binds for existing first row
    bindAllLottoInputs();
  }

  // -----------------------------
  // Wallet event listeners
  // -----------------------------
  function bindWalletEvents() {
    if (!window.ethereum) return;

    window.ethereum.on("accountsChanged", async (accs) => {
      if (!accs || !accs[0]) {
        setDisconnectedUI();
        return;
      }
      // Reconnect to update signer/account
      try {
        provider = new ethers.providers.Web3Provider(window.ethereum, "any");
        account = ethers.utils.getAddress(accs[0]);
        signer = provider.getSigner();

        vinRead = new ethers.Contract(ADDR_VIN, ERC20_ABI, provider);
        swapRead = new ethers.Contract(ADDR_SWAP, SWAP_ABI, provider);
        diceRead = new ethers.Contract(ADDR_DICE, DICE_ABI, provider);
        lottoRead = new ethers.Contract(ADDR_LOTTO, LOTTO_ABI, provider);

        vinWrite = vinRead.connect(signer);
        swapWrite = swapRead.connect(signer);
        diceWrite = diceRead.connect(signer);
        lottoWrite = lottoRead.connect(signer);

        setText("walletShort", shortAddr(account));
        setText("swapWallet", shortAddr(account));
        setText("diceWallet", shortAddr(account));
        setText("lottoWallet", shortAddr(account));

        await refreshAll();
      } catch (e) {
        console.error(e);
        setDisconnectedUI();
      }
    });

    window.ethereum.on("chainChanged", async () => {
      // Reload state on chain change
      setDisconnectedUI();
      // do not auto-connect, just wait user action
    });
  }

  // -----------------------------
  // Init
  // -----------------------------
  function init() {
    setDisconnectedUI();

    // Default screens & modes
    showScreen("home-screen");
    setSwapMode("VIN_TO_MON");
    setDiceChoice(0);
    setLottoMode(false);

    bindEvents();
    bindWalletEvents();

    // If wallet already connected, try soft-detect accounts (no popup)
    if (window.ethereum) {
      const eth = window.ethereum;
      eth.request({ method: "eth_accounts" })
        .then(async (accs) => {
          if (accs && accs[0]) {
            // Optional: auto-connect without prompt
            provider = new ethers.providers.Web3Provider(window.ethereum, "any");
            const net = await provider.getNetwork().catch(() => null);
            // Only auto-bind if on Monad
            if (net && net.chainId === CHAIN_ID_DEC) {
              account = ethers.utils.getAddress(accs[0]);
              signer = provider.getSigner();

              vinRead = new ethers.Contract(ADDR_VIN, ERC20_ABI, provider);
              swapRead = new ethers.Contract(ADDR_SWAP, SWAP_ABI, provider);
              diceRead = new ethers.Contract(ADDR_DICE, DICE_ABI, provider);
              lottoRead = new ethers.Contract(ADDR_LOTTO, LOTTO_ABI, provider);

              vinWrite = vinRead.connect(signer);
              swapWrite = swapRead.connect(signer);
              diceWrite = diceRead.connect(signer);
              lottoWrite = lottoRead.connect(signer);

              try {
                vinDecimals = await vinRead.decimals();
              } catch (_) {
                vinDecimals = 18;
              }

              setText("networkName", "Monad");
              const dot = $("networkDot");
              if (dot) {
                dot.classList.remove("dot-disconnected");
                dot.classList.add("dot-connected");
              }

              setText("walletShort", shortAddr(account));
              setText("swapWallet", shortAddr(account));
              setText("diceWallet", shortAddr(account));
              setText("lottoWallet", shortAddr(account));

              setDisabled("swapBtn", false);
              setDisabled("dicePlayBtn", false);
              setDisabled("lottoPlayBtn", false);
              setDisabled("swapApproveBtn", false);
              setDisabled("diceApproveBtn", false);
              setDisabled("lottoApproveBtn", false);

              await refreshAll();
            }
          }
        })
        .catch(() => {});
    }
  }

  // Run
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
