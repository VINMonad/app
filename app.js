/* app.js — VINMonad dApp (Swap • Dice • Lotto)
   - Chain: Monad (chainId 143)
   - Swap rate: 1 VIN = 100 MON
   - Approve default: 1,000,000 VIN
*/

(function () {
  "use strict";

  // -----------------------------
  // Constants
  // -----------------------------
  const CHAIN_ID_HEX = "0x8f"; // 143
  const RPC_URL = "https://rpc.monad.xyz";
  const EXPLORER_URL = "https://monadvision.com";

  // Contracts
  const ADDR_VIN = "0x038A2f1abe221d403834aa775669169Ef5eb120A";
  const ADDR_SWAP = "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB";
  const ADDR_DICE = "0xf2b1C0A522211949Ad2671b0F4bF92547d66ef3A";
  const ADDR_LOTTO = "0x17e945Bc2AeB9fcF9eb73DC4e4b8E2AE2962B525";

  const RATE_MON_PER_VIN = 100;
  const APPROVE_VIN_AMOUNT = "1000000"; // 1,000,000 VIN

  // -----------------------------
  // Minimal ABIs
  // -----------------------------
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];

  const SWAP_ABI = ["function swapVINtoMON(uint256 vinAmount)", "function swapMONtoVIN() payable"];

  const DICE_ABI = [
    "event Played(address indexed player,uint256 amount,uint8 choice,uint8 diceResult,uint16 roll,bool won)",
    "function play(uint256 amount, uint8 choice, uint256 clientSeed)",
    "function MIN_BET() view returns (uint256)",
    "function MAX_BET() view returns (uint256)",
  ];

  const LOTTO_ABI = [
    "event Played(address indexed player,bool bet27,uint8[] numbers,uint256[] amounts,uint8[27] results,uint256 totalBet,uint256 totalPayout)",
    "function play(bool bet27, uint8[] numbers, uint256[] amounts)",
  ];

  // -----------------------------
  // State
  // -----------------------------
  let provider = null;
  let signer = null;
  let account = null;

  let vinRead = null,
    vinWrite = null,
    swapRead = null,
    swapWrite = null,
    diceRead = null,
    diceWrite = null,
    lottoRead = null,
    lottoWrite = null;

  let vinDecimals = 18;

  let swapMode = "VIN_TO_MON"; // VIN_TO_MON | MON_TO_VIN
  let diceChoice = 0; // 0 EVEN, 1 ODD
  let lottoBet27 = false;

  // -----------------------------
  // DOM
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  function setText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function shortAddr(a) {
    if (!a || typeof a !== "string" || a.length < 10) return "-";
    return a.slice(0, 6) + "..." + a.slice(-4);
  }

  function formatUnitsSafe(bn, decimals, maxFrac) {
    try {
      const s = ethers.utils.formatUnits(bn, decimals);
      const n = Number(s);
      if (!Number.isFinite(n)) return s;
      return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac ?? 6 });
    } catch (_) {
      return "-";
    }
  }

  function toWeiSafe(amountStr, decimals) {
    const s = (amountStr || "").trim();
    if (!s) return null;
    if (!/^\d*\.?\d*$/.test(s)) return null;
    try {
      return ethers.utils.parseUnits(s, decimals);
    } catch (_) {
      return null;
    }
  }

  function setNetworkUI(connected, label) {
    const dot = $("networkDot");
    const name = $("networkName");
    if (dot) {
      dot.classList.toggle("dot-connected", !!connected);
      dot.classList.toggle("dot-disconnected", !connected);
    }
    if (name) name.textContent = label || (connected ? "Connected" : "Not connected");
  }

  function setConnectButtonUI(connected, addr) {
    const btn = $("connectBtn");
    if (!btn) return;
    btn.classList.toggle("connected", !!connected);
    btn.textContent = connected ? shortAddr(addr) : "Connect";
    btn.title = connected ? addr : "Connect wallet";
  }

  // -----------------------------
  // Screens
  // -----------------------------
  const screens = ["home-screen", "swap-screen", "dice-screen", "lotto-screen"];
  const navMap = {
    "home-screen": "navHome",
    "swap-screen": "navSwap",
    "dice-screen": "navDice",
    "lotto-screen": "navLotto",
  };

  function showScreen(screenId) {
    screens.forEach((id) => {
      const el = $(id);
      if (el) el.classList.toggle("screen-active", id === screenId);
    });

    Object.entries(navMap).forEach(([sid, nid]) => {
      const n = $(nid);
      if (n) n.classList.toggle("active", sid === screenId);
    });
  }

  // -----------------------------
  // Contracts init
  // -----------------------------
  async function initContracts() {
    if (!provider) return;

    vinRead = new ethers.Contract(ADDR_VIN, ERC20_ABI, provider);
    swapRead = new ethers.Contract(ADDR_SWAP, SWAP_ABI, provider);
    diceRead = new ethers.Contract(ADDR_DICE, DICE_ABI, provider);
    lottoRead = new ethers.Contract(ADDR_LOTTO, LOTTO_ABI, provider);

    vinDecimals = await vinRead.decimals().catch(() => 18);

    if (signer) {
      vinWrite = vinRead.connect(signer);
      swapWrite = swapRead.connect(signer);
      diceWrite = diceRead.connect(signer);
      lottoWrite = lottoRead.connect(signer);
    }
  }

  // -----------------------------
  // Wallet connect
  // -----------------------------
  async function ensureMonadChain() {
    if (!window.ethereum) return false;
    try {
      const cur = await window.ethereum.request({ method: "eth_chainId" });
      if (cur === CHAIN_ID_HEX) return true;

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
      return true;
    } catch (e) {
      try {
        await window.ethereum.request({
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
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async function connectWallet() {
    if (!window.ethereum) {
      alert("MetaMask not found.");
      return;
    }

    const ok = await ensureMonadChain();
    if (!ok) {
      alert("Please switch to Monad (chainId 143) in MetaMask.");
      return;
    }

    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();

    account = await signer.getAddress();

    setNetworkUI(true, "Monad");
    setConnectButtonUI(true, account);
    setText("walletShort", shortAddr(account));
    setText("homeNetwork", "Monad");
    setText("diceWalletShort", shortAddr(account));
    setText("lottoWallet", shortAddr(account));

    await initContracts();
    await refreshAll();
  }

  function disconnectUIOnly() {
    account = null;
    signer = null;

    setNetworkUI(false, "Not connected");
    setConnectButtonUI(false, "");
    setText("walletShort", "Not connected");
    setText("homeVinBal", "-");
    setText("homeMonBal", "-");
    setText("homeNetwork", "-");
    setText("homeDicePool", "-");
    setText("homeLottoPool", "-");

    setText("diceWalletShort", "-");
    setText("diceVinBal", "-");
    setText("diceMonBal", "-");
    setText("diceAllowance", "-");
    setText("dicePool", "-");
    setText("diceStatus", "Waiting for your action...");
    setText("diceResult", "-");
    setText("diceHash", "-");

    setText("swapFromBal", "Balance: -");
    setText("swapToBal", "Balance: -");
    setText("swapStatus", "Waiting for your action...");

    setText("lottoWallet", "-");
    setText("lottoVinBalance", "-");
    setText("lottoAllowance", "-");
    setText("lottoPool", "-");
    setText("lottoStatus", "Waiting for your action...");
    setText("lottoHash", "-");
    setText("lottoResultsGrid", "-");
    setText("lottoOutcome", "-");
    setText("lottoWinLoss", "-");
  }

  // -----------------------------
  // Reads
  // -----------------------------
  async function refreshBalances() {
    if (!provider || !account || !vinRead) return;

    const [monBal, vinBal] = await Promise.all([provider.getBalance(account), vinRead.balanceOf(account)]);

    setText("homeMonBal", formatUnitsSafe(monBal, 18, 4) + " MON");
    setText("homeVinBal", formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN");

    setText("diceMonBal", formatUnitsSafe(monBal, 18, 4) + " MON");
    setText("diceVinBal", formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN");

    setText("lottoVinBalance", formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN");

    if (swapMode === "VIN_TO_MON") {
      setText("swapFromBal", "Balance: " + formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN");
      setText("swapToBal", "Balance: " + formatUnitsSafe(monBal, 18, 4) + " MON");
      setText("swapFromToken", "VIN");
      setText("swapToToken", "MON");
    } else {
      setText("swapFromBal", "Balance: " + formatUnitsSafe(monBal, 18, 4) + " MON");
      setText("swapToBal", "Balance: " + formatUnitsSafe(vinBal, vinDecimals, 4) + " VIN");
      setText("swapFromToken", "MON");
      setText("swapToToken", "VIN");
    }
  }

  async function refreshPools() {
    if (!vinRead || !provider) return;

    const [diceVin, lottoVin] = await Promise.all([vinRead.balanceOf(ADDR_DICE), vinRead.balanceOf(ADDR_LOTTO)]);

    setText("homeDicePool", formatUnitsSafe(diceVin, vinDecimals, 4) + " VIN");
    setText("homeLottoPool", formatUnitsSafe(lottoVin, vinDecimals, 4) + " VIN");

    setText("dicePool", formatUnitsSafe(diceVin, vinDecimals, 4) + " VIN");
    setText("lottoPool", formatUnitsSafe(lottoVin, vinDecimals, 4) + " VIN");
  }

  async function refreshAllowances() {
    if (!account || !vinRead) return;

    const [aDice, aLotto, aSwap] = await Promise.all([
      vinRead.allowance(account, ADDR_DICE),
      vinRead.allowance(account, ADDR_LOTTO),
      vinRead.allowance(account, ADDR_SWAP),
    ]);

    setText("diceAllowance", formatUnitsSafe(aDice, vinDecimals, 4) + " VIN");
    setText("lottoAllowance", formatUnitsSafe(aLotto, vinDecimals, 4) + " VIN");

    // For swap approve only required when VIN->MON
    const btn = $("swapApproveBtn");
    if (btn) {
      if (swapMode === "VIN_TO_MON") {
        const ok = aSwap.gte(ethers.utils.parseUnits("1", vinDecimals));
        btn.disabled = ok || !account;
      } else {
        btn.disabled = true;
      }
    }
  }

  async function refreshDiceLimits() {
    if (!diceRead) return;
    try {
      const [minB, maxB] = await Promise.all([diceRead.MIN_BET(), diceRead.MAX_BET()]);
      setText(
        "diceMinMax",
        `Min ${formatUnitsSafe(minB, vinDecimals, 2)} / Max ${formatUnitsSafe(maxB, vinDecimals, 2)}`
      );
    } catch (_) {
      setText("diceMinMax", "Min 1 / Max 50");
    }
  }

  async function refreshAll() {
    await Promise.allSettled([refreshPools(), refreshBalances(), refreshAllowances(), refreshDiceLimits()]);
    const hint = $("homeHint");
    if (hint) hint.textContent = account ? "Connected ✓" : "Connect your wallet to load balances.";
  }

  // -----------------------------
  // Swap
  // -----------------------------
  function setSwapMode(mode) {
    swapMode = mode;
    const a = $("swapTabVinToMon");
    const b = $("swapTabMonToVin");
    if (a && b) {
      a.classList.toggle("active", mode === "VIN_TO_MON");
      b.classList.toggle("active", mode === "MON_TO_VIN");
    }

    const from = $("swapFromAmt");
    const to = $("swapToAmt");
    if (from) from.value = "";
    if (to) to.value = "";
    recalcSwapTo();
    refreshBalances().catch(() => {});
    refreshAllowances().catch(() => {});
    setText("swapStatus", "Waiting for your action...");
  }

  function recalcSwapTo() {
    const fromEl = $("swapFromAmt");
    const toEl = $("swapToAmt");
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
    const y = swapMode === "VIN_TO_MON" ? x * RATE_MON_PER_VIN : x / RATE_MON_PER_VIN;
    toEl.value = Number.isFinite(y) ? String(y) : "";
  }

  async function swapSetMax() {
    if (!provider || !account || !vinRead) return;
    const fromEl = $("swapFromAmt");
    if (!fromEl) return;

    const monBal = await provider.getBalance(account);
    const vinBal = await vinRead.balanceOf(account);

    if (swapMode === "VIN_TO_MON") {
      fromEl.value = ethers.utils.formatUnits(vinBal, vinDecimals);
    } else {
      const keep = ethers.utils.parseUnits("0.02", 18);
      const v = monBal.gt(keep) ? monBal.sub(keep) : ethers.BigNumber.from(0);
      fromEl.value = ethers.utils.formatUnits(v, 18);
    }
    recalcSwapTo();
  }

  async function approveVIN(spender, statusId) {
    if (!vinWrite || !account) return;
    try {
      setText(statusId, "Approving...");
      const amt = ethers.utils.parseUnits(APPROVE_VIN_AMOUNT, vinDecimals);
      const tx = await vinWrite.approve(spender, amt);
      setText(statusId, "Waiting confirm...");
      await tx.wait();
      setText(statusId, "Approved ✓");
      await refreshAllowances();
    } catch (e) {
      console.error(e);
      setText(statusId, "Approve failed.");
      alert("Approve failed or rejected.");
    }
  }

  async function doSwap() {
    if (!swapWrite || !account || !provider) {
      alert("Please connect wallet first.");
      return;
    }

    const fromEl = $("swapFromAmt");
    const amtBN =
      swapMode === "VIN_TO_MON"
        ? toWeiSafe(fromEl ? fromEl.value : "", vinDecimals)
        : toWeiSafe(fromEl ? fromEl.value : "", 18);

    if (!amtBN || amtBN.lte(0)) {
      alert("Invalid amount.");
      return;
    }

    try {
      setText("swapStatus", "Sending transaction...");
      let tx;

      if (swapMode === "VIN_TO_MON") {
        tx = await swapWrite.swapVINtoMON(amtBN);
      } else {
        tx = await swapWrite.swapMONtoVIN({ value: amtBN });
      }

      setText("swapStatus", "Waiting confirm...");
      await tx.wait();
      setText("swapStatus", "Swap done ✓");

      await refreshAll();
    } catch (e) {
      console.error(e);
      setText("swapStatus", "Swap failed.");
      alert("Swap failed or rejected.");
    }
  }

  // -----------------------------
  // Dice visuals (coins)
  // -----------------------------
  function setCoinColors(pattern) {
    // pattern array of 4: "white" | "red"
    for (let i = 0; i < 4; i++) {
      const el = $("coin" + i);
      if (!el) continue;
      el.classList.remove("coin-white", "coin-red");
      el.classList.add(pattern[i] === "red" ? "coin-red" : "coin-white");
    }
  }

  function randomEvenPattern() {
    const patterns = [
      ["white", "white", "white", "white"], // 4 white
      ["red", "red", "red", "red"], // 4 red
      ["white", "white", "red", "red"], // 2-2
    ];
    return patterns[Math.floor(Math.random() * patterns.length)];
  }

  function randomOddPattern() {
    const patterns = [
      ["red", "white", "white", "white"], // 1 red
      ["red", "red", "red", "white"], // 3 red
    ];
    return patterns[Math.floor(Math.random() * patterns.length)];
  }

  function shakeCoins() {
    const box = $("diceCoins");
    if (!box) return;
    box.classList.add("shake");
    setTimeout(() => box.classList.remove("shake"), 650);
  }

  function setDiceChoice(c) {
    diceChoice = c;

    const even = $("diceEvenBtn");
    const odd = $("diceOddBtn");
    if (even && odd) {
      even.classList.toggle("active", diceChoice === 0);
      odd.classList.toggle("active", diceChoice === 1);
      even.setAttribute("aria-pressed", diceChoice === 0 ? "true" : "false");
      odd.setAttribute("aria-pressed", diceChoice === 1 ? "true" : "false");
    }
  }

  function diceClear() {
    const amt = $("diceBetAmt");
    if (amt) amt.value = "1";
  }

  function diceHalf() {
    const amt = $("diceBetAmt");
    if (!amt) return;
    const v = Number((amt.value || "").trim());
    if (!Number.isFinite(v)) return;
    const n = Math.max(0, v / 2);
    amt.value = String(n);
  }

  function diceDouble() {
    const amt = $("diceBetAmt");
    if (!amt) return;
    const v = Number((amt.value || "").trim());
    if (!Number.isFinite(v)) return;
    const n = Math.max(0, v * 2);
    amt.value = String(n);
  }

  async function diceSetMax() {
    if (!diceRead) return;
    const maxEl = $("diceBetAmt");
    if (!maxEl) return;
    try {
      const maxB = await diceRead.MAX_BET();
      maxEl.value = ethers.utils.formatUnits(maxB, vinDecimals);
    } catch (_) {}
  }

  async function doDicePlay() {
    if (!diceWrite || !account) {
      alert("Please connect wallet first.");
      return;
    }

    const amtEl = $("diceBetAmt");
    const amountBN = toWeiSafe(amtEl ? amtEl.value : "", vinDecimals);
    if (!amountBN || amountBN.lte(0)) {
      alert("Invalid bet amount.");
      return;
    }

    try {
      setText("diceStatus", "Sending transaction...");
      setText("diceResult", "-");
      setText("diceHash", "-");

      // pre-visual shake
      shakeCoins();

      const clientSeed = Math.floor(Math.random() * 1e12);
      const tx = await diceWrite.play(amountBN, diceChoice, clientSeed);
      setText("diceStatus", "Waiting confirm...");
      const rc = await tx.wait();

      const blockHash = rc.blockHash || "-";
      setText("diceHash", "Hash: " + blockHash);

      // Parse Played
      let resultLine = "Done ✓";
      let isEvenResult = null;
      let won = null;
      let roll = null;

      try {
        for (const log of rc.logs) {
          try {
            const parsed = diceRead.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              won = !!parsed.args.won;
              const diceResult = Number(parsed.args.diceResult); // 0 even / 1 odd
              roll = Number(parsed.args.roll);
              isEvenResult = diceResult === 0;
              const outcomeTxt = isEvenResult ? "EVEN" : "ODD";
              const winLossTxt = won ? "WIN" : "LOSE";
              resultLine = `${outcomeTxt} • Roll: ${roll} • ${winLossTxt}`;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}

      // Final visual pattern based on on-chain outcome
      if (isEvenResult === true) {
        setCoinColors(randomEvenPattern());
      } else if (isEvenResult === false) {
        setCoinColors(randomOddPattern());
      }

      // final shake to feel "reveal"
      shakeCoins();

      setText("diceStatus", "Done ✓");
      setText("diceResult", resultLine);

      await refreshAll();
    } catch (e) {
      console.error(e);
      setText("diceStatus", "Play failed.");
      alert("Dice play failed or rejected.");
    }
  }

  // -----------------------------
  // Lotto helpers
  // -----------------------------
  function getRowEls() {
    const c = $("lottoRows");
    if (!c) return [];
    return Array.from(c.querySelectorAll(".row"));
  }

  function clamp2Digits(s) {
    const x = (s ?? "").toString().replace(/[^\d]/g, "").slice(0, 2);
    return x;
  }

  function normalizeNumberInput(el) {
    if (!el) return;
    el.value = clamp2Digits(el.value);
    if (el.value.length === 1) el.value = "0" + el.value;
    if (el.value.length === 0) el.value = "00";
  }

  async function refreshLottoTotal() {
    const rows = getRowEls();
    let total = 0;

    for (const r of rows) {
      const betEl = r.querySelector(".lottoAmount");
      const bn = toWeiSafe(betEl ? betEl.value : "", vinDecimals);
      if (bn && bn.gt(0)) total += Number(ethers.utils.formatUnits(bn, vinDecimals));
    }

    setText(
      "lottoTotalBet",
      Number.isFinite(total) ? total.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "0"
    );
  }

  function addLottoRow() {
    const c = $("lottoRows");
    if (!c) return;

    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="row-col">
        <label class="mini-label">Number (00–99)</label>
        <input class="lottoNumber" type="text" inputmode="numeric" maxlength="2" placeholder="00" value="00" />
      </div>
      <div class="row-col">
        <label class="mini-label">Bet Amount (VIN)</label>
        <input class="lottoAmount" type="text" inputmode="decimal" placeholder="1" value="1" />
      </div>
    `;
    c.appendChild(row);

    const num = row.querySelector(".lottoNumber");
    const amt = row.querySelector(".lottoAmount");
    if (num) num.addEventListener("input", () => (num.value = clamp2Digits(num.value)));
    if (num) num.addEventListener("blur", () => normalizeNumberInput(num));
    if (amt) amt.addEventListener("input", () => refreshLottoTotal().catch(() => {}));

    refreshLottoTotal().catch(() => {});
  }

  function removeLottoRow() {
    const rows = getRowEls();
    if (rows.length <= 1) return;
    rows[rows.length - 1].remove();
    refreshLottoTotal().catch(() => {});
  }

  function clearLotto() {
    const rows = getRowEls();
    rows.forEach((r, idx) => {
      const n = r.querySelector(".lottoNumber");
      const a = r.querySelector(".lottoAmount");
      if (n) n.value = "00";
      if (a) a.value = idx === 0 ? "1" : "0";
    });
    refreshLottoTotal().catch(() => {});
  }

  function scaleLotto(mult) {
    const rows = getRowEls();
    rows.forEach((r) => {
      const a = r.querySelector(".lottoAmount");
      if (!a) return;
      const v = Number((a.value || "").trim());
      if (!Number.isFinite(v)) return;
      a.value = String(Math.max(0, v * mult));
    });
    refreshLottoTotal().catch(() => {});
  }

  function readBetsFromUI() {
    const rows = getRowEls();
    const numbers = [];
    const amounts = [];

    for (const r of rows) {
      const numEl = r.querySelector(".lottoNumber");
      const betEl = r.querySelector(".lottoAmount");

      const numRaw = (numEl ? numEl.value : "").trim();
      const betRaw = (betEl ? betEl.value : "").trim();

      if (!numRaw && !betRaw) continue;

      if (!/^\d{1,2}$/.test(numRaw)) return { ok: false, reason: "Invalid number. Use 00–99." };
      const n = Number(numRaw);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { ok: false, reason: "Invalid number. Use 00–99." };

      const amtBN = toWeiSafe(betRaw, vinDecimals);
      if (!amtBN || amtBN.lte(0)) {
        return { ok: false, reason: "Invalid bet amount." };
      }

      numbers.push(n);
      amounts.push(amtBN);
    }

    if (numbers.length === 0) return { ok: false, reason: "No bets yet." };
    return { ok: true, numbers, amounts };
  }

  function setLottoMode(isBet27) {
    lottoBet27 = !!isBet27;
    const a = $("lottoTabBetOne");
    const b = $("lottoTabBet27");
    if (a && b) {
      a.classList.toggle("active", !lottoBet27);
      b.classList.toggle("active", lottoBet27);
    }
    setText("lottoStatus", "Waiting for your action...");
  }

  function render27Results(arr27) {
    const grid = $("lottoResultsGrid");
    if (!grid) return;
    grid.innerHTML = "";

    for (let i = 0; i < 27; i++) {
      const v = arr27[i];
      const pill = document.createElement("div");
      pill.className = "lotto-pill";
      pill.textContent = String(v).padStart(2, "0");
      grid.appendChild(pill);
    }

    grid.classList.add("lotto-results");
  }

  async function doLottoPlay() {
    if (!lottoWrite || !account) {
      alert("Please connect wallet first.");
      return;
    }

    const bets = readBetsFromUI();
    if (!bets.ok) {
      alert(bets.reason);
      return;
    }

    const numbers = bets.numbers;
    const amounts = bets.amounts;

    const sumLines = numbers.map(
      (n, i) => `${String(n).padStart(2, "0")} → ${formatUnitsSafe(amounts[i], vinDecimals, 4)} VIN`
    );
    setText("lottoBetSummary", (lottoBet27 ? "Bet27\n" : "BetOne\n") + sumLines.join("\n"));

    try {
      setText("lottoStatus", "Sending transaction...");
      setText("lottoHash", "-");
      setText("lottoOutcome", "-");
      setText("lottoWinLoss", "-");
      setText("lottoResultsGrid", "-");

      const tx = await lottoWrite.play(lottoBet27, numbers, amounts);
      setText("lottoStatus", "Waiting confirm...");
      const rc = await tx.wait();

      const blockHash = rc.blockHash || "-";
      setText("lottoHash", "Hash: " + blockHash);

      // Parse Played event to get results + payout
      let results27 = null;
      let totalBet = null;
      let totalPayout = null;

      try {
        for (const log of rc.logs) {
          try {
            const parsed = lottoRead.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              results27 = parsed.args.results;
              totalBet = parsed.args.totalBet;
              totalPayout = parsed.args.totalPayout;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}

      if (results27) {
        const arr = [];
        for (let i = 0; i < 27; i++) arr.push(Number(results27[i]));
        render27Results(arr);

        const betInfo = lottoBet27 ? "Bet27 applies to all 27 draws." : "BetOne applies only to draw #27.";
        setText("lottoOutcome", betInfo);
      } else {
        setText("lottoResultsGrid", "Results not found in logs.");
        setText("lottoOutcome", lottoBet27 ? "Bet27" : "BetOne");
      }

      // Win/Lose + payout
      let payoutVin = null;
      if (totalPayout) payoutVin = Number(ethers.utils.formatUnits(totalPayout, vinDecimals));

      const outcomeEl = $("lottoWinLoss");
      if (outcomeEl) {
        outcomeEl.classList.remove("win", "lose");
      }

      const won = payoutVin && payoutVin > 0;
      if (won) {
        setText("lottoWinLoss", `WIN • Payout: ${payoutVin.toLocaleString(undefined, { maximumFractionDigits: 6 })} VIN`);
        if (outcomeEl) outcomeEl.classList.add("win");
      } else {
        setText("lottoWinLoss", "LOSE • Payout: 0 VIN");
        if (outcomeEl) outcomeEl.classList.add("lose");
      }

      setText("lottoStatus", "Done ✓");
      await refreshAll();
    } catch (e) {
      console.error(e);
      setText("lottoStatus", "Play failed.");
      alert("Lotto play failed or rejected.");
    }
  }

  // -----------------------------
  // Bind UI
  // -----------------------------
  function bindUI() {
    // Nav
    $("navBrand") && $("navBrand").addEventListener("click", () => showScreen("home-screen"));
    $("navHome") && $("navHome").addEventListener("click", () => showScreen("home-screen"));
    $("navSwap") && $("navSwap").addEventListener("click", () => showScreen("swap-screen"));
    $("navDice") && $("navDice").addEventListener("click", () => showScreen("dice-screen"));
    $("navLotto") && $("navLotto").addEventListener("click", () => showScreen("lotto-screen"));

    // Home buttons
    $("goSwapBtn") && $("goSwapBtn").addEventListener("click", () => showScreen("swap-screen"));
    $("goDiceBtn") && $("goDiceBtn").addEventListener("click", () => showScreen("dice-screen"));
    $("goLottoBtn") && $("goLottoBtn").addEventListener("click", () => showScreen("lotto-screen"));
    $("refreshBtn") && $("refreshBtn").addEventListener("click", () => refreshAll().catch(() => {}));

    // Connect
    $("connectBtn") && $("connectBtn").addEventListener("click", () => connectWallet().catch(() => {}));

    // Swap
    $("swapTabVinToMon") && $("swapTabVinToMon").addEventListener("click", () => setSwapMode("VIN_TO_MON"));
    $("swapTabMonToVin") && $("swapTabMonToVin").addEventListener("click", () => setSwapMode("MON_TO_VIN"));
    $("swapFromAmt") && $("swapFromAmt").addEventListener("input", () => recalcSwapTo());
    $("swapMaxBtn") && $("swapMaxBtn").addEventListener("click", () => swapSetMax().catch(() => {}));
    $("swapApproveBtn") && $("swapApproveBtn").addEventListener("click", () => approveVIN(ADDR_SWAP, "swapStatus"));
    $("swapBtn") && $("swapBtn").addEventListener("click", () => doSwap().catch(() => {}));
    $("swapRefreshBtn") && $("swapRefreshBtn").addEventListener("click", () => refreshAll().catch(() => {}));

    // Dice
    $("diceEvenBtn") && $("diceEvenBtn").addEventListener("click", () => setDiceChoice(0));
    $("diceOddBtn") && $("diceOddBtn").addEventListener("click", () => setDiceChoice(1));
    $("diceMaxBtn") && $("diceMaxBtn").addEventListener("click", () => diceSetMax().catch(() => {}));
    $("diceApproveBtn") && $("diceApproveBtn").addEventListener("click", () => approveVIN(ADDR_DICE, "diceStatus"));
    $("diceRefreshBtn") && $("diceRefreshBtn").addEventListener("click", () => refreshAll().catch(() => {}));
    $("dicePlayBtn") && $("dicePlayBtn").addEventListener("click", () => doDicePlay().catch(() => {}));
    $("diceHalfBtn") && $("diceHalfBtn").addEventListener("click", () => diceHalf());
    $("diceDoubleBtn") && $("diceDoubleBtn").addEventListener("click", () => diceDouble());
    $("diceClearBtn") && $("diceClearBtn").addEventListener("click", () => diceClear());

    // Default coin view (even pattern)
    setCoinColors(["white", "white", "red", "red"]);
    setDiceChoice(0);

    // Lotto
    $("lottoApproveBtn") && $("lottoApproveBtn").addEventListener("click", () => approveVIN(ADDR_LOTTO, "lottoStatus"));
    $("lottoRefreshBtn") && $("lottoRefreshBtn").addEventListener("click", () => refreshAll().catch(() => {}));
    $("lottoTabBetOne") && $("lottoTabBetOne").addEventListener("click", () => setLottoMode(false));
    $("lottoTabBet27") && $("lottoTabBet27").addEventListener("click", () => setLottoMode(true));
    $("lottoAddRowBtn") && $("lottoAddRowBtn").addEventListener("click", () => addLottoRow());
    $("lottoRemoveRowBtn") && $("lottoRemoveRowBtn").addEventListener("click", () => removeLottoRow());
    $("lottoHalfBtn") && $("lottoHalfBtn").addEventListener("click", () => scaleLotto(0.5));
    $("lottoDoubleBtn") && $("lottoDoubleBtn").addEventListener("click", () => scaleLotto(2));
    $("lottoClearBtn") && $("lottoClearBtn").addEventListener("click", () => clearLotto());
    $("lottoPlayBtn") && $("lottoPlayBtn").addEventListener("click", () => doLottoPlay().catch(() => {}));

    // Bind initial row sanitizers
    const rows = getRowEls();
    rows.forEach((r) => {
      const num = r.querySelector(".lottoNumber");
      const amt = r.querySelector(".lottoAmount");
      if (num) num.addEventListener("input", () => (num.value = clamp2Digits(num.value)));
      if (num) num.addEventListener("blur", () => normalizeNumberInput(num));
      if (amt) amt.addEventListener("input", () => refreshLottoTotal().catch(() => {}));
    });

    refreshLottoTotal().catch(() => {});
  }

  // -----------------------------
  // Wallet events
  // -----------------------------
  function bindWalletEvents() {
    if (!window.ethereum) return;

    window.ethereum.on("accountsChanged", async (accs) => {
      if (!accs || accs.length === 0) {
        disconnectUIOnly();
        return;
      }
      account = accs[0];
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = provider.getSigner();

      setConnectButtonUI(true, account);
      setText("walletShort", shortAddr(account));
      setText("diceWalletShort", shortAddr(account));
      setText("lottoWallet", shortAddr(account));

      await initContracts();
      await refreshAll();
    });

    window.ethereum.on("chainChanged", () => {
      location.reload();
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    bindUI();
    bindWalletEvents();

    showScreen("home-screen");
    setNetworkUI(false, "Not connected");
    setConnectButtonUI(false, "");

    // Read-only preload pools without wallet
    try {
      const ro = new ethers.providers.JsonRpcProvider(RPC_URL);
      provider = ro;
      initContracts()
        .then(() => refreshPools())
        .catch(() => {});
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
