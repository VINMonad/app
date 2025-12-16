/* =========================================================
   VINMonad — app.js (English-only)
   Network: Monad (chainId 143)
   Modules: Home / Swap / Dice / Lotto (VINLottoV2)
   ========================================================= */

(() => {
  "use strict";

  // -----------------------
  // Network + Addresses
  // -----------------------
  const CHAIN_ID_DEC = 143;
  const CHAIN_ID_HEX = "0x8f";
  const RPC_URL = "https://rpc.monad.xyz";

  const ADDR = {
    VIN: "0x038A2f1abe221d403834aa775669169Ef5eb120A",
    SWAP: "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB",
    DICE: "0xf2b1C0A522211949Ad2671b0F4bF92547d66ef3A",
    LOTTO: "0x17e945Bc2AeB9fcF9eb73DC4e4b8E2AE2962B525",
  };

  // Swap fixed rate: 1 VIN = 100 MON
  const MON_PER_VIN = 100;
  const VIN_PER_MON = 1 / 100;

  // Default approvals (Dice + Lotto): 1,000,000 VIN
  const DEFAULT_APPROVE_VIN = "1000000";

  // -----------------------
  // Minimal ABIs
  // -----------------------
  const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];

  const SWAP_ABI = [
    "function RATE() view returns (uint256)",
    "function swapVINtoMON(uint256 vinAmount) external",
    "function swapMONtoVIN() external payable",
  ];

  const DICE_ABI = [
    "function MIN_BET() view returns (uint256)",
    "function MAX_BET() view returns (uint256)",
    "function play(uint256 amount, uint8 choice, uint256 clientSeed) external",
    "event Played(address indexed player,uint256 amount,uint8 choice,uint8 diceResult,uint16 roll,bool won)",
  ];

  const LOTTO_ABI = [
    "function MIN_BET() view returns (uint256)",
    "function play(bool bet27, uint8[] numbers, uint256[] amounts) external",
    "event Played(address indexed player,bool bet27,uint8[] numbers,uint256[] amounts,uint8[27] results,uint256 totalBet,uint256 totalPayout)",
  ];

  // -----------------------
  // State
  // -----------------------
  let rpcProvider;        // read-only
  let web3Provider;       // wallet provider
  let signer;             // wallet signer
  let user = null;

  let vinDecimals = 18;

  let vinRead, swapRead, diceRead, lottoRead;
  let vinWrite, swapWrite, diceWrite, lottoWrite;

  let isVinToMon = true;
  let diceChoice = "EVEN"; // EVEN / ODD

  // -----------------------
  // DOM helpers
  // -----------------------
  const $ = (id) => document.getElementById(id);

  const safeText = (el, text) => {
    if (!el) return;
    el.textContent = text;
  };

  const shorten = (addr) => {
    if (!addr || addr.length < 10) return addr || "";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  };

  const fmt = (n, d = 4) => {
    if (!Number.isFinite(n)) return "-";
    return n.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: d,
    });
  };

  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  };

  const extractRevertReason = (err) => {
    try {
      const msg = err?.data?.message || err?.error?.message || err?.message || "";
      const m = msg.match(/reverted with reason string '([^']+)'/i);
      if (m && m[1]) return m[1];
      const m2 = msg.match(/reason=([^,]+)/i);
      if (m2 && m2[1]) return m2[1];
      return "";
    } catch {
      return "";
    }
  };

  // -----------------------
  // Screen routing (expects these IDs exist in index.html)
  // -----------------------
  function showScreen(screenId) {
    const screens = document.querySelectorAll(".screen");
    screens.forEach((s) => s.classList.remove("active"));
    const el = $(screenId);
    if (el) el.classList.add("active");

    // highlight nav
    const navIds = ["navHome", "navSwap", "navDice", "navLotto"];
    navIds.forEach((nid) => $(nid)?.classList.remove("active"));

    if (screenId === "home-screen") $("navHome")?.classList.add("active");
    if (screenId === "swap-screen") $("navSwap")?.classList.add("active");
    if (screenId === "dice-screen") $("navDice")?.classList.add("active");
    if (screenId === "lotto-screen") $("navLotto")?.classList.add("active");
  }

  // -----------------------
  // Providers / Contracts
  // -----------------------
  function initRpcProvider() {
    if (!rpcProvider) rpcProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
    vinRead = new ethers.Contract(ADDR.VIN, ERC20_ABI, rpcProvider);
    swapRead = new ethers.Contract(ADDR.SWAP, SWAP_ABI, rpcProvider);
    diceRead = new ethers.Contract(ADDR.DICE, DICE_ABI, rpcProvider);
    lottoRead = new ethers.Contract(ADDR.LOTTO, LOTTO_ABI, rpcProvider);
  }

  function initWalletProvider() {
    if (!window.ethereum) throw new Error("No wallet found. Please install MetaMask.");
    web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    signer = web3Provider.getSigner();

    vinWrite = new ethers.Contract(ADDR.VIN, ERC20_ABI, signer);
    swapWrite = new ethers.Contract(ADDR.SWAP, SWAP_ABI, signer);
    diceWrite = new ethers.Contract(ADDR.DICE, DICE_ABI, signer);
    lottoWrite = new ethers.Contract(ADDR.LOTTO, LOTTO_ABI, signer);
  }

  async function ensureMonadNetwork() {
    if (!window.ethereum) return;

    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId === CHAIN_ID_HEX) return;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (switchErr) {
      // 4902 = chain not added
      if (switchErr?.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_ID_HEX,
              chainName: "Monad",
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: ["https://monad.blockscout.com"],
            },
          ],
        });
      } else {
        throw switchErr;
      }
    }
  }

  // -----------------------
  // Price chip (optional)
  // If index.html already fetches and renders VIN/USD, this will not break anything.
  // It tries to set elements if present: vinUsdChip, homeVinUsd, navVinUsd, etc.
  // VIN/USD = MON/USD * 100
  // -----------------------
  async function updateVinUsdChip() {
    const targets = [
      $("vinUsdChip"),
      $("homeVinUsd"),
      $("navVinUsd"),
      $("vinUsdPrice"),
    ].filter(Boolean);

    if (!targets.length) return;

    try {
      // CoinGecko simple price for MON
      const url =
        "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd";
      const res = await fetch(url, { cache: "no-store" });
      const js = await res.json();
      const monUsd = js?.monad?.usd;

      if (!Number.isFinite(monUsd)) throw new Error("Price unavailable");

      const vinUsd = monUsd * MON_PER_VIN;
      const text = `1 VIN = ${vinUsd.toFixed(2)} USD`; // 2 decimals as requested

      targets.forEach((el) => (el.textContent = text));
    } catch {
      targets.forEach((el) => (el.textContent = "Loading price..."));
    }
  }

  // -----------------------
  // Refresh UI (balances / pools / allowances)
  // -----------------------
  async function refreshAll() {
    initRpcProvider();

    // Read decimals once
    try {
      vinDecimals = await vinRead.decimals();
    } catch {
      vinDecimals = 18;
    }

    await Promise.allSettled([
      updateVinUsdChip(),
      refreshHome(),
      refreshSwap(),
      refreshDice(),
      refreshLotto(),
    ]);
  }

  async function refreshHome() {
    // wallet + balances
    const walletEls = [$("homeWallet"), $("homeWalletAddress"), $("walletAddressShort")].filter(Boolean);
    walletEls.forEach((el) => safeText(el, user ? shorten(user) : "Not connected"));

    safeText($("networkNameHome"), user ? "Monad" : "Not connected");

    // balances (if connected)
    if (!user) {
      safeText($("homeVinBalance"), "-");
      safeText($("homeMonBalance"), "-");
      safeText($("homeDicePool"), "Loading...");
      safeText($("homeLottoPool"), "Loading...");
      return;
    }

    try {
      const [vinBN, monBN, dicePoolBN, lottoPoolBN] = await Promise.all([
        vinRead.balanceOf(user),
        rpcProvider.getBalance(user),
        vinRead.balanceOf(ADDR.DICE),
        vinRead.balanceOf(ADDR.LOTTO),
      ]);

      const vinBal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));
      const monBal = Number(ethers.utils.formatEther(monBN));
      const dicePool = Number(ethers.utils.formatUnits(dicePoolBN, vinDecimals));
      const lottoPool = Number(ethers.utils.formatUnits(lottoPoolBN, vinDecimals));

      safeText($("homeVinBalance"), `${fmt(vinBal, 4)} VIN`);
      safeText($("homeMonBalance"), `${fmt(monBal, 4)} MON`);
      safeText($("homeDicePool"), `${fmt(dicePool, 4)} VIN`);
      safeText($("homeLottoPool"), `${fmt(lottoPool, 4)} VIN`);
    } catch {
      safeText($("homeVinBalance"), "-");
      safeText($("homeMonBalance"), "-");
    }
  }

  async function refreshSwap() {
    // wallet
    safeText($("swapWalletAddressShort"), user ? shorten(user) : "Not connected");
    safeText($("swapWallet"), user ? shorten(user) : "Not connected");

    // pool balances (always readable)
    try {
      const [poolVinBN, poolMonBN] = await Promise.all([
        vinRead.balanceOf(ADDR.SWAP),
        rpcProvider.getBalance(ADDR.SWAP),
      ]);
      const poolVin = Number(ethers.utils.formatUnits(poolVinBN, vinDecimals));
      const poolMon = Number(ethers.utils.formatEther(poolMonBN));
      safeText($("swapPoolVin"), `${fmt(poolVin, 4)} VIN`);
      safeText($("swapPoolMon"), `${fmt(poolMon, 4)} MON`);
    } catch {
      safeText($("swapPoolVin"), "Loading...");
      safeText($("swapPoolMon"), "Loading...");
    }

    if (!user) {
      safeText($("swapVinBalance"), "-");
      safeText($("swapMonBalance"), "-");
      safeText($("swapAllowance"), "-");
      safeText($("swapFromBalance"), "Balance: -");
      safeText($("swapToBalance"), "Balance: -");
      safeText($("swapRateLabel"), "Rate: -");
      return;
    }

    try {
      const [vinBN, monBN, allowanceBN] = await Promise.all([
        vinRead.balanceOf(user),
        rpcProvider.getBalance(user),
        vinRead.allowance(user, ADDR.SWAP),
      ]);

      const vinBal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));
      const monBal = Number(ethers.utils.formatEther(monBN));
      const allowance = Number(ethers.utils.formatUnits(allowanceBN, vinDecimals));

      safeText($("swapVinBalance"), `${fmt(vinBal, 4)} VIN`);
      safeText($("swapMonBalance"), `${fmt(monBal, 4)} MON`);
      safeText($("swapAllowance"), `${fmt(allowance, 4)} VIN`);

      // direction labels
      if (isVinToMon) {
        safeText($("swapFromToken"), "VIN");
        safeText($("swapToToken"), "MON");
        safeText($("swapFromBalance"), `Balance: ${fmt(vinBal, 4)} VIN`);
        safeText($("swapToBalance"), `Balance: ${fmt(monBal, 4)} MON`);
        safeText($("swapRateLabel"), `Rate: 1 VIN ≈ ${fmt(MON_PER_VIN, 4)} MON`);
      } else {
        safeText($("swapFromToken"), "MON");
        safeText($("swapToToken"), "VIN");
        safeText($("swapFromBalance"), `Balance: ${fmt(monBal, 4)} MON`);
        safeText($("swapToBalance"), `Balance: ${fmt(vinBal, 4)} VIN`);
        safeText($("swapRateLabel"), `Rate: 1 MON ≈ ${fmt(VIN_PER_MON, 6)} VIN`);
      }

      // recalc output
      recalcSwapOutput();
    } catch {
      // ignore
    }
  }

  async function refreshDice() {
    safeText($("diceWalletAddressShort"), user ? shorten(user) : "Not connected");
    safeText($("diceWallet"), user ? shorten(user) : "Not connected");

    // dice pool (always readable)
    try {
      const poolBN = await vinRead.balanceOf(ADDR.DICE);
      const pool = Number(ethers.utils.formatUnits(poolBN, vinDecimals));
      safeText($("dicePoolVin"), `${fmt(pool, 4)} VIN`);
      safeText($("globalDicePoolVin"), `${fmt(pool, 4)} VIN`);
    } catch {
      safeText($("dicePoolVin"), "Loading...");
      safeText($("globalDicePoolVin"), "Loading...");
    }

    if (!user) {
      safeText($("diceVinBalance"), "-");
      safeText($("diceMonBalance"), "-");
      safeText($("diceAllowance"), "-");
      return;
    }

    try {
      const [vinBN, monBN, allowanceBN, minBN, maxBN] = await Promise.all([
        vinRead.balanceOf(user),
        rpcProvider.getBalance(user),
        vinRead.allowance(user, ADDR.DICE),
        diceRead.MIN_BET(),
        diceRead.MAX_BET(),
      ]);

      const vinBal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));
      const monBal = Number(ethers.utils.formatEther(monBN));
      const allowance = Number(ethers.utils.formatUnits(allowanceBN, vinDecimals));
      const minBet = Number(ethers.utils.formatUnits(minBN, vinDecimals));
      const maxBet = Number(ethers.utils.formatUnits(maxBN, vinDecimals));

      safeText($("diceVinBalance"), `${fmt(vinBal, 4)} VIN`);
      safeText($("diceMonBalance"), `${fmt(monBal, 4)} MON`);
      safeText($("diceAllowance"), `${fmt(allowance, 4)} VIN`);

      // set default bet amount (min) if empty
      const betEl = $("diceBetAmount");
      if (betEl && (!betEl.value || Number(betEl.value) <= 0)) {
        betEl.value = String(minBet);
      }

      // optional min/max label
      safeText($("diceMinMaxLabel"), `MIN: ${fmt(minBet, 6)} VIN • MAX: ${fmt(maxBet, 2)} VIN`);
    } catch {
      // ignore
    }
  }

  async function refreshLotto() {
    safeText($("lottoWalletAddressShort"), user ? shorten(user) : "Not connected");
    safeText($("lottoWallet"), user ? shorten(user) : "Not connected");

    // lotto pool (always readable)
    try {
      const poolBN = await vinRead.balanceOf(ADDR.LOTTO);
      const pool = Number(ethers.utils.formatUnits(poolBN, vinDecimals));
      safeText($("lottoPoolVin"), `${fmt(pool, 4)} VIN`);
      safeText($("lottoPool"), `${fmt(pool, 4)} VIN`);
    } catch {
      safeText($("lottoPoolVin"), "Loading...");
      safeText($("lottoPool"), "Loading...");
    }

    if (!user) {
      safeText($("lottoVinBalance"), "-");
      safeText($("lottoMonBalance"), "-");
      safeText($("lottoAllowance"), "-");
      return;
    }

    try {
      const [vinBN, monBN, allowanceBN, minBN] = await Promise.all([
        vinRead.balanceOf(user),
        rpcProvider.getBalance(user),
        vinRead.allowance(user, ADDR.LOTTO),
        lottoRead.MIN_BET(),
      ]);

      const vinBal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));
      const monBal = Number(ethers.utils.formatEther(monBN));
      const allowance = Number(ethers.utils.formatUnits(allowanceBN, vinDecimals));
      const minBet = Number(ethers.utils.formatUnits(minBN, vinDecimals));

      safeText($("lottoVinBalance"), `${fmt(vinBal, 4)} VIN`);
      safeText($("lottoMonBalance"), `${fmt(monBal, 4)} MON`);
      safeText($("lottoAllowance"), `${fmt(allowance, 4)} VIN`);

      safeText($("lottoMinBetLabel"), `Min bet per row: ${fmt(minBet, 2)} VIN`);
      recalcLottoTotal();
    } catch {
      // ignore
    }
  }

  // -----------------------
  // Swap UI + Logic
  // -----------------------
  function setSwapDirection(vinToMon) {
    isVinToMon = vinToMon;

    $("tabVinToMon")?.classList.toggle("active", isVinToMon);
    $("tabMonToVin")?.classList.toggle("active", !isVinToMon);

    safeText($("swapFromToken"), isVinToMon ? "VIN" : "MON");
    safeText($("swapToToken"), isVinToMon ? "MON" : "VIN");

    const fromEl = $("swapFromAmount");
    const toEl = $("swapToAmount");
    if (fromEl) fromEl.value = "";
    if (toEl) toEl.value = "";

    recalcSwapOutput();
    refreshSwap().catch(() => {});
  }

  function recalcSwapOutput() {
    const fromEl = $("swapFromAmount");
    const toEl = $("swapToAmount");
    if (!fromEl || !toEl) return;

    const x = toNum(fromEl.value);
    if (x === null) {
      toEl.value = "";
      return;
    }

    if (isVinToMon) {
      toEl.value = (x * MON_PER_VIN).toString();
    } else {
      toEl.value = (x * VIN_PER_MON).toString();
    }
  }

  async function approveSwapIfNeeded(vinAmountBN) {
    if (!user) throw new Error("Wallet not connected.");

    const allowanceBN = await vinRead.allowance(user, ADDR.SWAP);
    if (allowanceBN.gte(vinAmountBN)) return;

    safeText($("swapStatus"), "Approving VIN for Swap...");
    const tx = await vinWrite.approve(ADDR.SWAP, ethers.constants.MaxUint256);
    await tx.wait();
    safeText($("swapStatus"), "Approval confirmed.");
  }

  async function handleSwap() {
    if (!user) {
      alert("Please connect your wallet first.");
      return;
    }

    try {
      initWalletProvider();

      const fromEl = $("swapFromAmount");
      const statusEl = $("swapStatus");
      if (!fromEl) return;

      const raw = String(fromEl.value || "").trim();
      const n = toNum(raw);
      if (n === null || n <= 0) {
        safeText(statusEl, "Enter a valid amount.");
        return;
      }

      if (isVinToMon) {
        const vinAmountBN = ethers.utils.parseUnits(raw, vinDecimals);

        // approve if needed
        await approveSwapIfNeeded(vinAmountBN);

        safeText(statusEl, "Sending VIN → MON swap transaction...");
        const tx = await swapWrite.swapVINtoMON(vinAmountBN);
        const r = await tx.wait();
        if (r.status !== 1) throw new Error("Swap reverted.");
        safeText(statusEl, "Swap VIN → MON successful!");
      } else {
        const monAmountBN = ethers.utils.parseEther(raw);

        safeText(statusEl, "Sending MON → VIN swap transaction...");
        const tx = await swapWrite.swapMONtoVIN({ value: monAmountBN });
        const r = await tx.wait();
        if (r.status !== 1) throw new Error("Swap reverted.");
        safeText(statusEl, "Swap MON → VIN successful!");
      }

      await refreshAll();
    } catch (err) {
      console.error(err);
      const reason = extractRevertReason(err);
      safeText($("swapStatus"), "Swap failed. " + (reason ? `Reason: ${reason}` : ""));
      alert("Swap failed.\n" + (reason ? `Reason: ${reason}` : ""));
    }
  }

  async function handleSwapApproveClick() {
    if (!user) {
      alert("Please connect your wallet first.");
      return;
    }
    try {
      initWalletProvider();
      safeText($("swapStatus"), "Approving VIN for Swap...");
      const tx = await vinWrite.approve(ADDR.SWAP, ethers.constants.MaxUint256);
      await tx.wait();
      safeText($("swapStatus"), "Approval confirmed.");
      await refreshSwap();
    } catch (err) {
      console.error(err);
      const reason = extractRevertReason(err);
      safeText($("swapStatus"), "Approval failed. " + (reason ? `Reason: ${reason}` : ""));
    }
  }

  async function handleSwapMax() {
    if (!user) return;
    const fromEl = $("swapFromAmount");
    if (!fromEl) return;

    try {
      const [vinBN, monBN] = await Promise.all([
        vinRead.balanceOf(user),
        rpcProvider.getBalance(user),
      ]);

      if (isVinToMon) {
        fromEl.value = ethers.utils.formatUnits(vinBN, vinDecimals);
      } else {
        fromEl.value = ethers.utils.formatEther(monBN);
      }
      recalcSwapOutput();
    } catch {
      // ignore
    }
  }

  // -----------------------
  // Dice UI + Logic
  // -----------------------
  function setDiceChoice(choice) {
    diceChoice = choice;

    $("diceEvenBtn")?.classList.toggle("active", diceChoice === "EVEN");
    $("diceOddBtn")?.classList.toggle("active", diceChoice === "ODD");
  }

  async function ensureDiceApproval() {
    if (!user) throw new Error("Wallet not connected.");

    const needed = ethers.utils.parseUnits(DEFAULT_APPROVE_VIN, vinDecimals);
    const allowanceBN = await vinRead.allowance(user, ADDR.DICE);
    if (allowanceBN.gte(needed)) return;

    safeText($("diceStatus"), "Approving VIN for Dice...");
    const tx = await vinWrite.approve(ADDR.DICE, needed);
    await tx.wait();
    safeText($("diceStatus"), "Dice approval confirmed.");
  }

  function getDiceVisualResult(isEven) {
    // Even: 3 possible visuals; Odd: 2 possible visuals
    const evenResults = [
      ["white", "white", "white", "white"],
      ["red", "red", "red", "red"],
      ["white", "white", "red", "red"],
    ];
    const oddResults = [
      ["red", "white", "red", "red"],
      ["red", "red", "red", "white"],
    ];
    const arr = isEven ? evenResults : oddResults;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function displayDiceVisual(colors) {
    const coins = document.querySelectorAll(".dice-coin");
    colors.forEach((color, idx) => {
      const c = coins[idx];
      if (!c) return;
      c.classList.remove("dice-coin-white", "dice-coin-red");
      c.classList.add(color === "white" ? "dice-coin-white" : "dice-coin-red");
    });
  }

  async function playDice() {
    if (!user) {
      alert("Please connect your wallet first.");
      return;
    }

    const statusEl = $("diceStatus");
    const betEl = $("diceBetAmount");
    if (!betEl) return;

    try {
      initWalletProvider();

      // approval (1,000,000 VIN)
      await ensureDiceApproval();

      const raw = String(betEl.value || "").trim();
      const n = toNum(raw);
      if (n === null || n <= 0) {
        safeText(statusEl, "Enter a valid bet amount.");
        return;
      }

      const amountBN = ethers.utils.parseUnits(raw, vinDecimals);

      // min/max checks
      const [minBN, maxBN] = await Promise.all([diceRead.MIN_BET(), diceRead.MAX_BET()]);
      if (amountBN.lt(minBN)) {
        safeText(statusEl, "Bet is below minimum.");
        return;
      }
      if (amountBN.gt(maxBN)) {
        safeText(statusEl, "Bet is above maximum.");
        return;
      }

      // animation start
      $("dicePlayBtn")?.classList.add("loading");
      safeText(statusEl, "Confirm the transaction in your wallet...");

      // randomness input
      const clientSeed = Math.floor(Math.random() * 1e16);

      const choiceUint8 = diceChoice === "EVEN" ? 0 : 1;

      // send tx
      const tx = await diceWrite.play(amountBN, choiceUint8, clientSeed);
      safeText(statusEl, "Transaction sent. Waiting for confirmation...");
      const r = await tx.wait();
      if (r.status !== 1) throw new Error("Dice reverted.");

      // decode Played event
      let played = null;
      for (const ev of r.events || []) {
        if (ev.event === "Played" && ev.args) {
          played = ev.args;
          break;
        }
      }

      if (played) {
        const won = Boolean(played.won);
        const diceRes = Number(played.diceResult); // 0 even, 1 odd
        const roll = Number(played.roll);

        const isEven = diceRes === 0;
        displayDiceVisual(getDiceVisualResult(isEven));

        const resultText = `Result: ${isEven ? "EVEN" : "ODD"} • Roll: ${roll} • ${won ? "WIN" : "LOSE"}`;
        safeText($("diceResultText"), resultText);
        safeText(statusEl, "Done.");
      } else {
        safeText(statusEl, "Done.");
      }

      await refreshAll();
    } catch (err) {
      console.error(err);
      const reason = extractRevertReason(err);
      safeText($("diceStatus"), "Dice failed. " + (reason ? `Reason: ${reason}` : ""));
      alert("Dice failed.\n" + (reason ? `Reason: ${reason}` : ""));
    } finally {
      $("dicePlayBtn")?.classList.remove("loading");
    }
  }

  async function handleDiceApproveClick() {
    if (!user) {
      alert("Please connect your wallet first.");
      return;
    }
    try {
      initWalletProvider();
      await ensureDiceApproval();
      await refreshDice();
    } catch (err) {
      console.error(err);
      const reason = extractRevertReason(err);
      safeText($("diceStatus"), "Approval failed. " + (reason ? `Reason: ${reason}` : ""));
    }
  }

  async function handleDiceMax() {
    if (!user) return;
    const betEl = $("diceBetAmount");
    if (!betEl) return;

    try {
      const [maxBN, vinBN] = await Promise.all([diceRead.MAX_BET(), vinRead.balanceOf(user)]);
      // keep safe: user balance must cover bet, but also dice contract requires bank >= 2x bet
      const max = Number(ethers.utils.formatUnits(maxBN, vinDecimals));
      const bal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));
      betEl.value = String(Math.max(0, Math.min(max, bal)));
    } catch {
      // ignore
    }
  }

  // -----------------------
  // Lotto UI + Logic (VINLottoV2)
  // -----------------------
  function getBetRowsContainer() {
    return $("betRows") || $("lottoBetRows") || $("betRowsContainer");
  }

  function createLottoRow(number = "", amount = "") {
    const row = document.createElement("div");
    row.className = "bet-row";

    row.innerHTML = `
      <div class="bet-row-col">
        <label class="bet-label">Number (00–99)</label>
        <input class="bet-input bet-number" inputmode="numeric" pattern="[0-9]*" maxlength="2" placeholder="00" value="${number}">
      </div>
      <div class="bet-row-col">
        <label class="bet-label">Bet Amount (VIN)</label>
        <input class="bet-input bet-amount" inputmode="decimal" placeholder="1" value="${amount}">
      </div>
    `;

    // events
    const numEl = row.querySelector(".bet-number");
    const amtEl = row.querySelector(".bet-amount");

    if (numEl) {
      numEl.addEventListener("input", () => {
        // keep only digits and max 2
        numEl.value = numEl.value.replace(/[^\d]/g, "").slice(0, 2);
        recalcLottoTotal();
      });
      numEl.addEventListener("blur", () => {
        // format "7" -> "07"
        const v = numEl.value.trim();
        if (v.length === 1) numEl.value = "0" + v;
      });
    }

    if (amtEl) {
      amtEl.addEventListener("input", () => {
        recalcLottoTotal();
      });
    }

    return row;
  }

  function ensureAtLeastOneLottoRow() {
    const c = getBetRowsContainer();
    if (!c) return;
    if (c.children.length === 0) {
      c.appendChild(createLottoRow("", "1"));
    }
  }

  function getLottoRowsData() {
    const c = getBetRowsContainer();
    if (!c) return { numbers: [], amounts: [], total: 0, invalid: true };

    const rows = Array.from(c.querySelectorAll(".bet-row"));
    const numbers = [];
    const amounts = [];
    let total = 0;

    let invalid = false;

    for (const r of rows) {
      const numEl = r.querySelector(".bet-number");
      const amtEl = r.querySelector(".bet-amount");

      const numStr = String(numEl?.value || "").trim();
      const amtStr = String(amtEl?.value || "").trim();

      const n = toNum(numStr);
      const a = toNum(amtStr);

      if (n === null || n < 0 || n > 99) invalid = true;
      if (a === null || a < 1) invalid = true;

      numbers.push(n === null ? 0 : n);
      amounts.push(a === null ? 0 : a);
      total += a === null ? 0 : a;
    }

    if (rows.length === 0) invalid = true;

    return { numbers, amounts, total, invalid };
  }

  function recalcLottoTotal() {
    ensureAtLeastOneLottoRow();
    const { total, invalid } = getLottoRowsData();

    safeText($("lottoTotalBet"), `${fmt(total, 4)} VIN`);
    safeText($("lottoTotalBetValue"), `${fmt(total, 4)} VIN`);

    // status preview
    if ($("betStatus")) {
      safeText($("betStatus"), invalid ? "Waiting for your action..." : "Ready.");
    }

    // disable play button if invalid
    const btn = $("lottoPlayBtn") || $("placeBetBtn") || $("lottoPlaceBet");
    if (btn) btn.disabled = invalid;

    return { total, invalid };
  }

  function addLottoRow() {
    const c = getBetRowsContainer();
    if (!c) return;
    c.appendChild(createLottoRow("", "1"));
    recalcLottoTotal();
    updateRemoveRowState();
  }

  function removeLottoRow() {
    const c = getBetRowsContainer();
    if (!c) return;
    if (c.children.length <= 1) return;
    c.removeChild(c.lastElementChild);
    recalcLottoTotal();
    updateRemoveRowState();
  }

  function updateRemoveRowState() {
    const c = getBetRowsContainer();
    const btn = $("removeRowBtn") || $("lottoRemoveRow");
    if (!btn || !c) return;
    btn.disabled = c.children.length <= 1;
  }

  function halfAllBets() {
    const c = getBetRowsContainer();
    if (!c) return;
    const amts = c.querySelectorAll(".bet-amount");
    amts.forEach((el) => {
      const n = toNum(el.value);
      if (n === null) return;
      el.value = String(Math.max(1, n / 2));
    });
    recalcLottoTotal();
  }

  function doubleAllBets() {
    const c = getBetRowsContainer();
    if (!c) return;
    const amts = c.querySelectorAll(".bet-amount");
    amts.forEach((el) => {
      const n = toNum(el.value);
      if (n === null) return;
      el.value = String(n * 2);
    });
    recalcLottoTotal();
  }

  function clearAllBets() {
    const c = getBetRowsContainer();
    if (!c) return;
    c.innerHTML = "";
    c.appendChild(createLottoRow("", "1"));
    recalcLottoTotal();
    updateRemoveRowState();

    safeText($("yourBet"), "No bet yet");
    safeText($("resultStatus"), "No result yet");
    safeText($("profitStatus"), "No win/loss yet");
    safeText($("betStatus"), "Waiting for your action...");
  }

  function getLottoModeBet27() {
    // expects radio ids: betOne / bet27 OR lottoBetOne / lottoBet27
    const bet27 = $("bet27") || $("lottoBet27");
    const betOne = $("betOne") || $("lottoBetOne");
    if (bet27 && betOne) return !!bet27.checked;
    // fallback: select
    const sel = $("lottoMode");
    if (sel) return String(sel.value).toLowerCase().includes("27");
    return false;
  }

  async function ensureLottoApproval(totalBetVin) {
    if (!user) throw new Error("Wallet not connected.");

    // Approve 1,000,000 VIN (not just total bet)
    const needed = ethers.utils.parseUnits(DEFAULT_APPROVE_VIN, vinDecimals);
    const allowanceBN = await vinRead.allowance(user, ADDR.LOTTO);
    if (allowanceBN.gte(needed)) return;

    safeText($("betStatus"), "Approving VIN for Lotto...");
    const tx = await vinWrite.approve(ADDR.LOTTO, needed);
    await tx.wait();
    safeText($("betStatus"), "Lotto approval confirmed.");
  }

  async function handleLottoApproveClick() {
    if (!user) {
      alert("Please connect your wallet first.");
      return;
    }
    try {
      initWalletProvider();
      await ensureLottoApproval(0);
      await refreshLotto();
    } catch (err) {
      console.error(err);
      const reason = extractRevertReason(err);
      safeText($("betStatus"), "Approval failed. " + (reason ? `Reason: ${reason}` : ""));
    }
  }

  function formatResultsArray(results27) {
    // show as 00, 07, 88...
    const arr = Array.from(results27 || []).map((x) => {
      const n = Number(x);
      if (!Number.isFinite(n)) return "??";
      return String(n).padStart(2, "0");
    });
    return arr.join(" ");
  }

  async function playLotto() {
    if (!user) {
      alert("Please connect your wallet first.");
      return;
    }

    try {
      initWalletProvider();

      ensureAtLeastOneLottoRow();
      const { numbers, amounts, total, invalid } = getLottoRowsData();
      if (invalid) {
        safeText($("betStatus"), "Please enter valid numbers (00–99) and bets (>= 1 VIN).");
        return;
      }

      const bet27 = getLottoModeBet27();

      // Build calldata arrays
      const numsU8 = numbers.map((n) => Number(n) & 0xff);
      const amtsBN = amounts.map((a) => ethers.utils.parseUnits(String(a), vinDecimals));

      // Approval (1,000,000 VIN)
      await ensureLottoApproval(total);

      // Update "Your Bet"
      const betLines = numsU8
        .map((n, i) => `${String(n).padStart(2, "0")} : ${fmt(amounts[i], 4)} VIN`)
        .join(" | ");
      safeText($("yourBet"), betLines || "No bet yet");

      safeText($("betStatus"), "Confirm the transaction in your wallet...");

      const tx = await lottoWrite.play(bet27, numsU8, amtsBN);
      safeText($("betStatus"), "Transaction sent. Waiting for confirmation...");

      const r = await tx.wait();
      if (r.status !== 1) throw new Error("Lotto reverted.");

      // decode event
      let played = null;
      for (const ev of r.events || []) {
        if (ev.event === "Played" && ev.args) {
          played = ev.args;
          break;
        }
      }

      if (played) {
        const results = played.results; // uint8[27]
        const totalBetBN = played.totalBet;
        const totalPayoutBN = played.totalPayout;

        const totalBet = Number(ethers.utils.formatUnits(totalBetBN, vinDecimals));
        const totalPayout = Number(ethers.utils.formatUnits(totalPayoutBN, vinDecimals));
        const profit = totalPayout - totalBet;

        safeText($("resultStatus"), formatResultsArray(results));
        safeText($("profitStatus"), profit >= 0 ? `WIN: ${fmt(profit, 4)} VIN` : `LOSS: ${fmt(Math.abs(profit), 4)} VIN`);
        safeText($("betStatus"), "Done.");
      } else {
        safeText($("betStatus"), "Done.");
      }

      await refreshAll();
    } catch (err) {
      console.error(err);
      const reason = extractRevertReason(err);
      safeText($("betStatus"), "Lotto failed. " + (reason ? `Reason: ${reason}` : ""));
      alert("Lotto failed.\n" + (reason ? `Reason: ${reason}` : ""));
    }
  }

  // -----------------------
  // Connect wallet
  // -----------------------
  async function connect() {
    try {
      initRpcProvider();
      await ensureMonadNetwork();

      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      user = accounts?.[0] || null;

      initWalletProvider();

      // live updates
      window.ethereum.on?.("accountsChanged", (accs) => {
        user = accs?.[0] || null;
        refreshAll().catch(() => {});
      });

      window.ethereum.on?.("chainChanged", () => {
        window.location.reload();
      });

      await refreshAll();
    } catch (err) {
      console.error(err);
      alert("Wallet connection failed.");
    }
  }

  // -----------------------
  // Wire events
  // -----------------------
  function initEvents() {
    // nav
    $("navHome")?.addEventListener("click", () => showScreen("home-screen"));
    $("navSwap")?.addEventListener("click", () => showScreen("swap-screen"));
    $("navDice")?.addEventListener("click", () => showScreen("dice-screen"));
    $("navLotto")?.addEventListener("click", () => showScreen("lotto-screen"));

    // home buttons
    $("goSwap")?.addEventListener("click", () => showScreen("swap-screen"));
    $("goDice")?.addEventListener("click", () => showScreen("dice-screen"));
    $("goLotto")?.addEventListener("click", () => showScreen("lotto-screen"));

    // connect
    $("connectBtn")?.addEventListener("click", connect);
    $("connectButton")?.addEventListener("click", connect);

    // refresh
    $("refreshBalances")?.addEventListener("click", () => refreshAll());

    // swap direction
    $("tabVinToMon")?.addEventListener("click", () => setSwapDirection(true));
    $("tabMonToVin")?.addEventListener("click", () => setSwapDirection(false));

    // swap inputs
    $("swapFromAmount")?.addEventListener("input", recalcSwapOutput);

    // swap actions
    $("swapMaxBtn")?.addEventListener("click", handleSwapMax);
    $("swapMaxButton")?.addEventListener("click", handleSwapMax);
    $("swapApproveBtn")?.addEventListener("click", handleSwapApproveClick);
    $("swapActionBtn")?.addEventListener("click", handleSwap);
    $("swapActionButton")?.addEventListener("click", handleSwap);

    // dice choice
    $("diceEvenBtn")?.addEventListener("click", () => setDiceChoice("EVEN"));
    $("diceOddBtn")?.addEventListener("click", () => setDiceChoice("ODD"));

    // dice actions
    $("diceApproveBtn")?.addEventListener("click", handleDiceApproveClick);
    $("dicePlayBtn")?.addEventListener("click", playDice);
    $("diceMaxBtn")?.addEventListener("click", handleDiceMax);
    $("diceMaxButton")?.addEventListener("click", handleDiceMax);

    // lotto rows
    $("addRowBtn")?.addEventListener("click", addLottoRow);
    $("removeRowBtn")?.addEventListener("click", removeLottoRow);

    // lotto quick tools
    $("halfBtn")?.addEventListener("click", halfAllBets);
    $("doubleBtn")?.addEventListener("click", doubleAllBets);
    $("clearBtn")?.addEventListener("click", clearAllBets);

    // lotto approve / play
    $("lottoApproveBtn")?.addEventListener("click", handleLottoApproveClick);
    $("placeBetBtn")?.addEventListener("click", playLotto);
    $("lottoPlayBtn")?.addEventListener("click", playLotto);

    // initialize defaults
    setSwapDirection(true);
    setDiceChoice("EVEN");
  }

  // -----------------------
  // Boot
  // -----------------------
  async function boot() {
    initRpcProvider();
    initEvents();
    ensureAtLeastOneLottoRow();
    updateRemoveRowState();
    recalcLottoTotal();
    showScreen("home-screen");

    // preload price chip
    await updateVinUsdChip();

    // refresh read-only pools even without wallet
    await refreshAll();
    setInterval(updateVinUsdChip, 30_000);
  }

  boot().catch(console.error);
})();
