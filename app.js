// app.js - VINMonad dApp
// Uses ethers.js v5.7.2 (loaded from CDN in index.html)

(function () {
  "use strict";

  /* ========================
     GLOBAL CONSTANTS & STATE
  ======================== */

  // Monad chain
  const TARGET_CHAIN_ID = 143;
  const TARGET_CHAIN_NAME = "Monad";

  // Contracts (from user)
  const VIN_TOKEN_ADDRESS = "0x038A2f1abe221d403834aa775669169Ef5eb120A";
  const SWAP_CONTRACT_ADDRESS = "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB";
  const DICE_CONTRACT_ADDRESS = "0xB8D7D799eE31FedD38e63801419782E8110326E4";
  const LOTTO_CONTRACT_ADDRESS = "0x85993C463f2b4a8656871891b463AeA79734ab27";

  // Token decimals
  const VIN_DECIMALS = 18;
  const MON_DECIMALS = 18;

  // Approve amounts
  const SWAP_APPROVE_AMOUNT = "100000000"; // 100M VIN allowance for Swap
  const DICE_APPROVE_AMOUNT = "100000000"; // 100M VIN allowance for Dice
  const LOTTO_APPROVE_AMOUNT = "100000000"; // 100M VIN allowance for Lotto

  // ===== Fixed Gas Limits (no estimateGas) =====
  // These values are intentionally a bit generous to avoid intermittent 'gas estimation failed' errors.
  // If Monad gas rules change, you can safely increase them.
  const GAS_APPROVE = 80000;
  const GAS_SWAP_VIN_TO_MON = 220000;
  const GAS_SWAP_MON_TO_VIN = 220000;
  const GAS_DICE_PLAY = 260000;
  const GAS_LOTTO_PLAY_BASE = 320000;
  const GAS_LOTTO_PLAY_PER_ROW = 140000;
  const GAS_LOTTO_PLAY_CAP = 2500000;

  function bnGas(n) {
    return window.ethers.BigNumber.from(String(n));
  }
  function capGas(n, cap) {
    return n.gt(cap) ? cap : n;
  }

  async function sendTxWithFixedGas(txPromiseFactory, gasLimitBN) {
    // txPromiseFactory: (gasLimitBN) => Promise<TransactionResponse>
    // Retry once with +35% gas if the first attempt fails due to gas estimation / unpredictable gas.
    const bump = (g) => g.mul(135).div(100);

    try {
      return await txPromiseFactory(gasLimitBN);
    } catch (err) {
      const msg = String((err && (err.message || err.reason)) || err || "");
      const code = err && err.code;

      const likelyGas =
        code === "UNPREDICTABLE_GAS_LIMIT" ||
        code === -32000 ||
        /gas estimation|UNPREDICTABLE_GAS_LIMIT|intrinsic gas too low|out of gas/i.test(
          msg
        );

      if (!likelyGas) throw err;

      const g2 = bump(gasLimitBN);
      return await txPromiseFactory(g2);
    }
  }

  // ABIs (keep embedded)
  const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Approval(address indexed owner, address indexed spender, uint256 value)"
  ];

  // Swap ABI (must match your deployed swap contract)
  // NOTE: This app assumes swap functions:
  // - swapVINtoMON(uint256 vinAmount)
  // - swapMONtoVIN() payable
  // - getContractBalances() view returns (uint256 vinBalance, uint256 monBalance) (optional)
  // If your swap differs, update the ABI accordingly.
  const SWAP_ABI = [
    "function swapVINtoMON(uint256 vinAmount) external",
    "function swapMONtoVIN() external payable",
    "function getContractBalances() view returns (uint256 vinBalance, uint256 monBalance)"
  ];

  // Dice ABI (must match your deployed dice contract)
  // Assumes:
  // - play(uint256 amount, uint8 choice, uint256 clientSeed)
  // - MIN_BET() view returns(uint256)
  // - MAX_BET() view returns(uint256)
  // - getBalance() view returns(uint256) or pool balance reading
  // - event Played(address indexed player, uint256 amount, uint8 choice, uint8 result, bool won, uint256 payout, bytes32 hash, uint256 seed)
  const DICE_ABI = [
    "function MIN_BET() view returns (uint256)",
    "function MAX_BET() view returns (uint256)",
    "function getBalance() view returns (uint256)",
    "function play(uint256 amount, uint8 choice, uint256 clientSeed) external",
    "event Played(address indexed player, uint256 amount, uint8 choice, uint8 result, bool won)"
  ];

  // Lotto ABI (must match your deployed lotto contract)
  // Assumes:
  // - MIN_BET() view returns(uint256)
  // - getBalance() view returns(uint256)
  // - play((uint8 number,uint256 amount,uint8 betType)[] bets)   // betType: 0=BetOne, 1=Bet27
  // Event signature may differ; decode uses tx receipt + interface parsing where possible.
  const LOTTO_ABI = [
    "function MIN_BET() view returns (uint256)",
    "function getBalance() view returns (uint256)",
    "function play(tuple(uint8 number,uint256 amount,uint8 betType)[] bets) external"
  ];

  // Providers & contracts
  let ethProvider = null; // web3 provider
  let readProvider = null; // fallback JSON-RPC read provider (optional)
  let signer = null;
  let currentAccount = null;

  let vinRead = null,
    vinWrite = null;
  let swapRead = null,
    swapWrite = null;
  let diceRead = null,
    diceWrite = null;
  let lottoRead = null,
    lottoWrite = null;

  // UI state
  let swapMode = "VIN_TO_MON"; // or "MON_TO_VIN"
  let selectedDiceChoice = null; // "EVEN" or "ODD"

  const lastDiceBet = {
    amount: "",
    choice: "",
    tx: "",
    result: "",
    win: false
  };

  let lottoRowCounter = 1;

  /* ========================
        DOM HELPERS
  ======================== */

  function $(id) {
    return document.getElementById(id);
  }

  function setText(elOrId, text) {
    const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
    if (!el) return;
    el.textContent = text;
  }

  function setHTML(elOrId, html) {
    const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
    if (!el) return;
    el.innerHTML = html;
  }

  function setStatus(id, msg) {
    setText(id, msg);
  }

  function shortAddr(addr) {
    if (!addr) return "Not connected";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  function formatUnitsRaw(bn, decimals) {
    try {
      return window.ethers.utils.formatUnits(bn, decimals);
    } catch {
      return "0";
    }
  }

  function formatTokenPretty(bn, decimals, maxDecimals = 6) {
    try {
      const s = window.ethers.utils.formatUnits(bn, decimals);
      // trim
      if (!s.includes(".")) return s;
      const [a, b] = s.split(".");
      return a + "." + b.slice(0, maxDecimals).replace(/0+$/, "");
    } catch {
      return "0";
    }
  }

  // Robust numeric parsing (accepts ',' and '.')
  function parseUnitsSafe(str, decimals) {
    if (str === null || str === undefined) return null;
    let s = String(str).trim();
    s = s.replace(/,/g, ".");
    s = s.replace(/[^\d.]/g, "");
    if (!s || s === ".") return null;

    const parts = s.split(".");
    if (parts.length > 1) {
      const intPart = parts.shift();
      const fracPart = parts.join("");
      s = intPart + "." + fracPart;
    }

    try {
      return window.ethers.utils.parseUnits(s, decimals);
    } catch {
      return null;
    }
  }

  function getRandomClientSeed() {
    if (window.crypto && window.crypto.getRandomValues) {
      const arr = new Uint32Array(2);
      window.crypto.getRandomValues(arr);
      const high = BigInt(arr[0]);
      const low = BigInt(arr[1]);
      return high * (1n << 32n) + low;
    }
    return BigInt(Date.now());
  }

  function extractRevertReason(error) {
    try {
      if (!error) return "";
      if (error.error && error.error.message) return error.error.message;
      if (error.data && typeof error.data === "string") return error.data;
      if (error.message) return error.message;
    } catch {
      // ignore
    }
    return "";
  }

  /* ========================
        NETWORK / WALLET
  ======================== */

  function initReadProvider() {
    // Optional read provider: if you have a public RPC, you can set it here.
    // For now we rely on the injected provider for reads as well.
    // readProvider = new ethers.providers.JsonRpcProvider("https://rpc.monad.xyz");
    readProvider = null;
  }

  function setNetworkStatus(ok) {
    setText("networkStatus", ok ? "Connected" : "Wrong network");
  }

  async function ensureWallet() {
    if (!window.ethereum) {
      alert("MetaMask not found. Please install MetaMask.");
      return false;
    }

    ethProvider = new window.ethers.providers.Web3Provider(window.ethereum, "any");

    try {
      const net = await ethProvider.getNetwork();
      if (!net || net.chainId !== TARGET_CHAIN_ID) {
        setNetworkStatus(false);
        // still allow connect, but warn
      } else {
        setNetworkStatus(true);
      }
    } catch {
      setNetworkStatus(false);
    }

    return true;
  }

  function buildContracts() {
    if (!ethProvider) return;

    // read contracts (provider)
    vinRead = new window.ethers.Contract(VIN_TOKEN_ADDRESS, ERC20_ABI, ethProvider);
    swapRead = new window.ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, ethProvider);
    diceRead = new window.ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, ethProvider);
    lottoRead = new window.ethers.Contract(LOTTO_CONTRACT_ADDRESS, LOTTO_ABI, ethProvider);

    if (signer) {
      vinWrite = vinRead.connect(signer);
      swapWrite = swapRead.connect(signer);
      diceWrite = diceRead.connect(signer);
      lottoWrite = lottoRead.connect(signer);
    } else {
      vinWrite = null;
      swapWrite = null;
      diceWrite = null;
      lottoWrite = null;
    }
  }

  async function connectWallet() {
    const ok = await ensureWallet();
    if (!ok) return;

    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      currentAccount = accounts && accounts[0] ? accounts[0] : null;
      signer = ethProvider.getSigner();

      buildContracts();
      await refreshAllBalancesAndPools();
      syncWalletUI();

      // Listen changes
      window.ethereum.on("accountsChanged", async (accs) => {
        currentAccount = accs && accs[0] ? accs[0] : null;
        signer = currentAccount ? ethProvider.getSigner() : null;
        buildContracts();
        syncWalletUI();
        await refreshAllBalancesAndPools();
      });

      window.ethereum.on("chainChanged", async () => {
        // re-init
        await ensureWallet();
        signer = currentAccount ? ethProvider.getSigner() : null;
        buildContracts();
        await refreshAllBalancesAndPools();
        syncWalletUI();
      });
    } catch (err) {
      console.error("connectWallet error:", err);
      alert("Wallet connection rejected.");
    }
  }

  function syncWalletUI() {
    const short = shortAddr(currentAccount);

    setText("walletAddressShort", currentAccount ? short : "Not connected");
    setText("diceWalletAddressShort", currentAccount ? short : "Not connected");
    setText("lottoWalletAddressShort", currentAccount ? short : "Not connected");

    const btn = $("connectButton");
    if (btn) btn.textContent = currentAccount ? "Connected" : "Connect Wallet";
  }

  /* ========================
        NAVIGATION
  ======================== */

  function showScreen(screenId) {
    const screens = document.querySelectorAll(".screen");
    screens.forEach((s) => s.classList.remove("active"));
    const t = $(screenId);
    if (t) t.classList.add("active");
  }

  function setActiveNav(navId) {
    const links = document.querySelectorAll(".nav-link");
    links.forEach((l) => l.classList.remove("active"));
    const t = $(navId);
    if (t) t.classList.add("active");
  }

  function initNav() {
    const homeBtn = $("navHome");
    const swapBtn = $("navSwap");
    const diceBtn = $("navDice");
    const lottoBtn = $("navLotto");

    if (homeBtn)
      homeBtn.addEventListener("click", () => {
        showScreen("home-screen");
        setActiveNav("navHome");
      });

    if (swapBtn)
      swapBtn.addEventListener("click", () => {
        showScreen("swap-screen");
        setActiveNav("navSwap");
      });

    if (diceBtn)
      diceBtn.addEventListener("click", () => {
        showScreen("dice-screen");
        setActiveNav("navDice");
      });

    if (lottoBtn)
      lottoBtn.addEventListener("click", () => {
        showScreen("lotto-screen");
        setActiveNav("navLotto");
      });
  }

  /* ========================
        BALANCES & POOLS
  ======================== */

  async function refreshBalances() {
    try {
      initReadProvider();

      if (!currentAccount || !vinRead || !ethProvider) {
        setText("vinBalance", "-");
        setText("monBalance", "-");
        setText("diceVinBalance", "-");
        setText("diceMonBalance", "-");
        setText("lottoVinBalance", "-");
        setText("lottoMonBalance", "-");
        return;
      }

      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(currentAccount),
        ethProvider.getBalance(currentAccount)
      ]);

      setText("vinBalance", `${formatTokenPretty(vinBal, VIN_DECIMALS, 4)} VIN`);
      setText("monBalance", `${formatTokenPretty(monBal, MON_DECIMALS, 4)} MON`);

      // Dice screen balances
      setText("diceVinBalance", `${formatTokenPretty(vinBal, VIN_DECIMALS, 4)} VIN`);
      setText("diceMonBalance", `${formatTokenPretty(monBal, MON_DECIMALS, 4)} MON`);

      // Lotto screen balances
      setText("lottoVinBalance", `${formatTokenPretty(vinBal, VIN_DECIMALS, 4)} VIN`);
      setText("lottoMonBalance", `${formatTokenPretty(monBal, MON_DECIMALS, 4)} MON`);
    } catch (err) {
      console.error("refreshBalances error:", err);
    }
  }

  async function refreshAllowances() {
    try {
      if (!currentAccount || !vinRead) {
        setText("swapAllowance", "-");
        setText("diceAllowance", "-");
        setText("lottoAllowance", "-");
        return;
      }

      const [allowSwap, allowDice, allowLotto] = await Promise.all([
        vinRead.allowance(currentAccount, SWAP_CONTRACT_ADDRESS),
        vinRead.allowance(currentAccount, DICE_CONTRACT_ADDRESS),
        vinRead.allowance(currentAccount, LOTTO_CONTRACT_ADDRESS)
      ]);

      setText("swapAllowance", `${formatTokenPretty(allowSwap, VIN_DECIMALS, 2)} VIN`);
      setText("diceAllowance", `${formatTokenPretty(allowDice, VIN_DECIMALS, 2)} VIN`);
      // NOTE: index.html mistakenly labels it "Dice Allowance" in lotto screen; keep it
      setText("lottoAllowance", `${formatTokenPretty(allowLotto, VIN_DECIMALS, 2)} VIN`);
    } catch (err) {
      console.error("refreshAllowances error:", err);
    }
  }

  async function updateDicePool() {
    try {
      if (!diceRead) return;
      let pool;
      if (diceRead.getBalance) {
        pool = await diceRead.getBalance();
      } else {
        // fallback: read VIN in dice contract
        pool = await vinRead.balanceOf(DICE_CONTRACT_ADDRESS);
      }
      setText("dicePoolVin", `${formatTokenPretty(pool, VIN_DECIMALS, 4)} VIN`);
    } catch (err) {
      console.error("updateDicePool error:", err);
      setText("dicePoolVin", "N/A");
    }
  }

  async function updateLottoPool() {
    try {
      if (!lottoRead) return;
      let pool;
      if (lottoRead.getBalance) {
        pool = await lottoRead.getBalance();
      } else {
        pool = await vinRead.balanceOf(LOTTO_CONTRACT_ADDRESS);
      }
      setText("lottoPoolVin", `${formatTokenPretty(pool, VIN_DECIMALS, 4)} VIN`);
    } catch (err) {
      console.error("updateLottoPool error:", err);
      setText("lottoPoolVin", "N/A");
    }
  }

  async function refreshAllBalancesAndPools() {
    await refreshBalances();
    await refreshAllowances();
    await updateDicePool();
    await updateLottoPool();
  }

  /* ========================
        SWAP LOGIC
  ======================== */

  function initSwapEvents() {
    const btnFlip = $("swapFlip");
    const btnApprove = $("swapApproveButton");
    const btnSwap = $("swapActionButton");

    const vinIn = $("swapVinInput");
    const monIn = $("swapMonInput");

    if (btnFlip)
      btnFlip.addEventListener("click", () => {
        swapMode = swapMode === "VIN_TO_MON" ? "MON_TO_VIN" : "VIN_TO_MON";
        updateSwapModeUI();
      });

    if (btnApprove)
      btnApprove.addEventListener("click", async () => {
        await swapApprove();
      });

    if (btnSwap)
      btnSwap.addEventListener("click", async () => {
        await swapAction();
      });

    if (vinIn)
      vinIn.addEventListener("input", () => {
        // optional: you can add live calc if you have a rate
      });

    if (monIn)
      monIn.addEventListener("input", () => {
        // optional: you can add live calc if you have a rate
      });

    updateSwapModeUI();
  }

  function updateSwapModeUI() {
    const title = $("swapModeTitle");
    const vinRow = $("swapVinRow");
    const monRow = $("swapMonRow");

    // If your HTML structure differs, this still works safely.
    if (swapMode === "VIN_TO_MON") {
      if (title) title.textContent = "Swap VIN → MON";
      if (vinRow) vinRow.style.display = "";
      if (monRow) monRow.style.display = "";
      // you can choose to highlight input direction
    } else {
      if (title) title.textContent = "Swap MON → VIN";
      if (vinRow) vinRow.style.display = "";
      if (monRow) monRow.style.display = "";
    }
  }

  async function swapApprove() {
    if (!vinWrite || !currentAccount) {
      alert("Connect your wallet first.");
      return;
    }
    setStatus("swapStatus", "Sending approval transaction...");

    try {
      const approveAmount = window.ethers.utils.parseUnits(
        SWAP_APPROVE_AMOUNT,
        VIN_DECIMALS
      );

      const txApprove = await sendTxWithFixedGas(
        (g) =>
          vinWrite.approve(SWAP_CONTRACT_ADDRESS, approveAmount, { gasLimit: g }),
        bnGas(GAS_APPROVE)
      );

      setStatus("swapStatus", "Waiting for confirmation...");
      await txApprove.wait();

      setStatus("swapStatus", "Swap approval successful.");
      await refreshAllBalancesAndPools();
    } catch (err) {
      console.error("swapApprove error:", err);
      if (err.code === 4001) {
        setStatus("swapStatus", "User rejected approval.");
      } else {
        const reason = extractRevertReason(err);
        setStatus("swapStatus", `Approval failed. ${reason ? reason : ""}`.trim());
      }
    }
  }

  async function swapAction() {
    if (!swapWrite || !currentAccount) {
      alert("Connect your wallet first.");
      return;
    }

    try {
      if (swapMode === "VIN_TO_MON") {
        const vinIn = $("swapVinInput");
        const vinAmountBN = parseUnitsSafe(vinIn ? vinIn.value : "", VIN_DECIMALS);
        if (!vinAmountBN || vinAmountBN.lte(0)) {
          alert("Enter a valid VIN amount.");
          return;
        }

        setStatus("swapStatus", "Submitting swap VIN → MON...");
        const tx = await sendTxWithFixedGas(
          (g) => swapWrite.swapVINtoMON(vinAmountBN, { gasLimit: g }),
          bnGas(GAS_SWAP_VIN_TO_MON)
        );

        setStatus("swapStatus", "Waiting for confirmation...");
        await tx.wait();

        setStatus("swapStatus", "Swap successful.");
      } else {
        const monIn = $("swapMonInput");
        const monAmountBN = parseUnitsSafe(monIn ? monIn.value : "", MON_DECIMALS);
        if (!monAmountBN || monAmountBN.lte(0)) {
          alert("Enter a valid MON amount.");
          return;
        }

        setStatus("swapStatus", "Submitting swap MON → VIN...");
        const tx = await sendTxWithFixedGas(
          (g) => swapWrite.swapMONtoVIN({ value: monAmountBN, gasLimit: g }),
          bnGas(GAS_SWAP_MON_TO_VIN)
        );

        setStatus("swapStatus", "Waiting for confirmation...");
        await tx.wait();

        setStatus("swapStatus", "Swap successful.");
      }

      await refreshAllBalancesAndPools();
    } catch (err) {
      console.error("swapAction error:", err);
      if (err.code === 4001) {
        setStatus("swapStatus", "User rejected transaction.");
      } else {
        const reason = extractRevertReason(err);
        setStatus(
          "swapStatus",
          `Swap failed. ${reason ? reason : "Check console for details."}`.trim()
        );
      }
    }
  }

  /* ========================
        DICE UI (COINS)
  ======================== */

  function generateDiceCoinsPattern(isEven) {
    // Even patterns: 4 white, 4 red, 2 white 2 red (random)
    // Odd patterns: 1 red, 3 red (random)
    const patternsEven = [
      ["W", "W", "W", "W"],
      ["R", "R", "R", "R"],
      ["W", "W", "R", "R"]
    ];
    const patternsOdd = [
      ["R", "W", "W", "W"],
      ["R", "R", "R", "W"]
    ];

    const arr = isEven ? patternsEven : patternsOdd;
    const pick = arr[Math.floor(Math.random() * arr.length)];

    // shuffle for realism
    const shuffled = pick.slice().sort(() => Math.random() - 0.5);
    return shuffled;
  }

  function applyDiceCoinsPattern(pattern) {
    // coins are elements: diceCoin1..4 or .dice-coin nodes
    const container = $("diceCoins");
    if (!container) return;

    const coins = container.querySelectorAll(".dice-coin");
    if (!coins || coins.length < 4) return;

    for (let i = 0; i < 4; i++) {
      const c = coins[i];
      const v = pattern[i] || "W";
      c.classList.remove("coin-red", "coin-white");
      c.classList.add(v === "R" ? "coin-red" : "coin-white");
    }
  }

  function startDiceShake() {
    const container = $("diceCoins");
    if (!container) return;
    container.classList.add("shaking");
  }

  function stopDiceShake() {
    const container = $("diceCoins");
    if (!container) return;
    container.classList.remove("shaking");
  }

  function updateDiceLastResultUI() {
    if (!lastDiceBet.tx) return;
    setText("diceLastResult", lastDiceBet.result || "-");
    setText("diceLastOutcome", `Result: ${lastDiceBet.result || "-"}`);
    const wl = $("diceLastWinLoss");
    if (wl) {
      wl.textContent = lastDiceBet.win ? "WIN" : "LOSE";
      wl.classList.toggle("win", !!lastDiceBet.win);
      wl.classList.toggle("lose", !lastDiceBet.win);
    }
    setText("diceLastPayout", lastDiceBet.win ? `${lastDiceBet.payout} VIN` : "0 VIN");
    setText("diceLastTx", lastDiceBet.tx || "-");
  }

  /* ========================
        DICE LOGIC
  ======================== */

  function initDiceEvents() {
    const evenBtn = $("diceChooseEven");
    const oddBtn = $("diceChooseOdd");
    const approveBtn = $("diceApproveButton");
    const playBtn = $("dicePlayButton");

    const quickRepeat = $("diceRepeat");
    const quickHalf = $("diceHalf");
    const quickDouble = $("diceDouble");
    const quickClear = $("diceClear");

    const refreshLast = $("diceRefreshLast");

    if (evenBtn)
      evenBtn.addEventListener("click", () => {
        selectedDiceChoice = "EVEN";
        updateDiceChoiceUI();
      });

    if (oddBtn)
      oddBtn.addEventListener("click", () => {
        selectedDiceChoice = "ODD";
        updateDiceChoiceUI();
      });

    if (approveBtn)
      approveBtn.addEventListener("click", async () => {
        await diceApprove();
      });

    if (playBtn)
      playBtn.addEventListener("click", async () => {
        await dicePlay();
      });

    if (quickRepeat) quickRepeat.addEventListener("click", diceQuickRepeat);
    if (quickHalf) quickHalf.addEventListener("click", diceQuickHalf);
    if (quickDouble) quickDouble.addEventListener("click", diceQuickDouble);
    if (quickClear) quickClear.addEventListener("click", diceQuickClear);

    if (refreshLast) refreshLast.addEventListener("click", diceRefreshLastGame);

    updateDiceChoiceUI();
  }

  function updateDiceChoiceUI() {
    const evenBtn = $("diceChooseEven");
    const oddBtn = $("diceChooseOdd");
    if (evenBtn) evenBtn.classList.toggle("active", selectedDiceChoice === "EVEN");
    if (oddBtn) oddBtn.classList.toggle("active", selectedDiceChoice === "ODD");
  }

  async function diceApprove() {
    if (!vinWrite || !currentAccount) {
      alert("Connect your wallet first.");
      return;
    }

    const statusId = "diceStatus";
    setStatus(statusId, "Sending approval transaction for Dice...");

    try {
      const approveAmountBN = window.ethers.utils.parseUnits(
        DICE_APPROVE_AMOUNT,
        VIN_DECIMALS
      );

      const tx = await sendTxWithFixedGas(
        (g) =>
          vinWrite.approve(DICE_CONTRACT_ADDRESS, approveAmountBN, { gasLimit: g }),
        bnGas(GAS_APPROVE)
      );

      setStatus(statusId, "Waiting for confirmation...");
      await tx.wait();

      setStatus(statusId, "Dice approval successful.");
      await refreshAllBalancesAndPools();
    } catch (err) {
      console.error("diceApprove error:", err);
      if (err.code === 4001) {
        setStatus(statusId, "User rejected approval transaction.");
      } else {
        const reason = extractRevertReason(err);
        setStatus(statusId, `Dice approval failed. ${reason ? reason : ""}`.trim());
      }
    }
  }

  async function dicePlay() {
    if (!diceWrite || !currentAccount || !vinRead) {
      alert("Connect your wallet first.");
      return;
    }

    if (!selectedDiceChoice) {
      alert("Choose EVEN or ODD first.");
      return;
    }

    const amountInput = $("diceBetAmount");
    const raw = amountInput ? amountInput.value : "";
    const amountBN = parseUnitsSafe(raw, VIN_DECIMALS);
    if (!amountBN || amountBN.lte(0)) {
      alert("Enter a valid bet amount.");
      return;
    }

    const choiceEnum = selectedDiceChoice === "EVEN" ? 0 : 1;
    const clientSeed = getRandomClientSeed();

    const statusId = "diceStatus";
    setStatus(statusId, "Preparing Dice transaction...");

    // Start shake immediately; stop only after result or failure
    startDiceShake();

    try {
      // Optional: read min/max bet
      try {
        const [minBet, maxBet] = await Promise.all([
          diceRead.MIN_BET(),
          diceRead.MAX_BET()
        ]);

        if (minBet && amountBN.lt(minBet)) {
          stopDiceShake();
          alert(
            `Bet must be at least ${formatTokenPretty(minBet, VIN_DECIMALS, 4)} VIN.`
          );
          return;
        }
        if (maxBet && amountBN.gt(maxBet)) {
          stopDiceShake();
          alert(
            `Bet must be at most ${formatTokenPretty(maxBet, VIN_DECIMALS, 4)} VIN.`
          );
          return;
        }
      } catch (e) {
        // ignore if contract doesn't support
      }

      setStatus(statusId, "Sending Dice transaction (fixed gas)...");

      const tx = await sendTxWithFixedGas(
        (g) => diceWrite.play(amountBN, choiceEnum, clientSeed, { gasLimit: g }),
        bnGas(GAS_DICE_PLAY)
      );

      setStatus(statusId, "Waiting for confirmation...");
      const receipt = await tx.wait();

      // Parse Played event (from receipt logs)
      let resultStr = "-";
      let won = false;

      try {
        const iface = new window.ethers.utils.Interface(DICE_ABI);
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== DICE_CONTRACT_ADDRESS.toLowerCase()) continue;
          try {
            const parsed = iface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              const result = parsed.args.result; // 0 even, 1 odd
              won = !!parsed.args.won;
              resultStr = result === 0 ? "EVEN" : "ODD";
              break;
            }
          } catch {
            // ignore
          }
        }
      } catch (e) {
        console.warn("Failed to parse dice event:", e);
      }

      // Apply visual pattern based on result
      if (resultStr === "EVEN" || resultStr === "ODD") {
        const isEven = resultStr === "EVEN";
        const pattern = generateDiceCoinsPattern(isEven);
        applyDiceCoinsPattern(pattern);
      }

      // Save last bet
      lastDiceBet.amount = raw ? String(raw) : "";
      lastDiceBet.choice = selectedDiceChoice;
      lastDiceBet.tx = receipt.transactionHash;
      lastDiceBet.result = resultStr;
      lastDiceBet.win = won;

      const payoutBN = won ? amountBN.mul(2) : window.ethers.BigNumber.from(0);
      lastDiceBet.payout = formatTokenPretty(payoutBN, VIN_DECIMALS, 4);

      updateDiceLastResultUI();
      setStatus(statusId, won ? "WIN ✅" : "LOSE ❌");

      stopDiceShake();
      await refreshAllBalancesAndPools();
    } catch (err) {
      console.error("dicePlay error:", err);
      stopDiceShake();

      if (err.code === 4001) {
        setStatus(statusId, "User rejected transaction.");
      } else {
        const reason = extractRevertReason(err);
        setStatus(
          statusId,
          `Dice play failed. ${reason ? reason : "This bet might revert."}`.trim()
        );
      }
    }
  }

  async function diceRefreshLastGame() {
    if (!ethProvider || !diceRead || !currentAccount) {
      alert("Connect your wallet first.");
      return;
    }
    const statusId = "diceStatus";
    setStatus(statusId, "Fetching last Dice game from chain...");

    try {
      const iface = new window.ethers.utils.Interface(DICE_ABI);

      const filter = {
        address: DICE_CONTRACT_ADDRESS,
        topics: [iface.getEventTopic("Played"), window.ethers.utils.hexZeroPad(currentAccount, 32)],
        fromBlock: 0,
        toBlock: "latest"
      };

      const logs = await ethProvider.getLogs(filter);
      if (!logs.length) {
        setStatus(statusId, "No Dice games found for this wallet.");
        return;
      }

      const lastLog = logs[logs.length - 1];
      const parsed = iface.parseLog(lastLog);
      const amount = parsed.args.amount;
      const choice = parsed.args.choice;
      const result = parsed.args.result;
      const won = parsed.args.won;

      const resultStr = result === 0 ? "EVEN" : "ODD";
      const payoutBN = won ? amount.mul(2) : window.ethers.BigNumber.from(0);

      const isEven = result === 0;
      const pattern = generateDiceCoinsPattern(isEven);
      applyDiceCoinsPattern(pattern);

      lastDiceBet.tx = lastLog.transactionHash || "-";
      lastDiceBet.result = resultStr;
      lastDiceBet.win = !!won;
      lastDiceBet.payout = formatTokenPretty(payoutBN, VIN_DECIMALS, 4);

      updateDiceLastResultUI();
      setStatus(statusId, "Last Dice game loaded.");
    } catch (err) {
      console.error("diceRefreshLastGame error:", err);
      setStatus(statusId, "Failed to load last Dice game.");
    }
  }

  function diceQuickRepeat() {
    const input = $("diceBetAmount");
    if (!input) return;
    if (!lastDiceBet.amount) return;
    input.value = lastDiceBet.amount;
  }

  function diceQuickHalf() {
    const input = $("diceBetAmount");
    if (!input) return;
    const raw = String(input.value || "").trim();
    if (!raw) return;
    const bn = parseUnitsSafe(raw, VIN_DECIMALS);
    if (!bn) return;
    const half = bn.div(2);
    input.value = formatUnitsRaw(half, VIN_DECIMALS);
  }

  function diceQuickDouble() {
    const input = $("diceBetAmount");
    if (!input) return;
    const raw = String(input.value || "").trim();
    if (!raw) return;
    const bn = parseUnitsSafe(raw, VIN_DECIMALS);
    if (!bn) return;
    const dbl = bn.mul(2);
    input.value = formatUnitsRaw(dbl, VIN_DECIMALS);
  }

  function diceQuickClear() {
    const input = $("diceBetAmount");
    if (input) input.value = "";
  }

  /* ========================
        LOTTO LOGIC
  ======================== */

  function createLottoRow() {
    const container = $("lottoRows");
    if (!container) return;

    const rowIndex = lottoRowCounter++;
    const row = document.createElement("div");
    row.className = "lotto-row";

    row.innerHTML = `
      <input type="text" class="lotto-number" placeholder="00–99" maxlength="2" />
      <input type="text" class="lotto-amount" placeholder="1–50" />
      <div class="lotto-type">
        <label>
          <input type="radio" name="lottoType${rowIndex}" value="betone" checked />
          BetOne
        </label>
        <label>
          <input type="radio" name="lottoType${rowIndex}" value="bet27" />
          Bet27
        </label>
      </div>
      <button class="btn-remove-row">✕</button>
    `;

    container.appendChild(row);
  }

  function refreshLottoTotalBet() {
    const rowsContainer = $("lottoRows");
    if (!rowsContainer) return;

    const rows = rowsContainer.querySelectorAll(".lotto-row");
    let totalBN = window.ethers.BigNumber.from(0);

    rows.forEach((row) => {
      const amountInput = row.querySelector(".lotto-amount");
      if (!amountInput) return;
      const raw = String(amountInput.value || "").trim();
      if (!raw) return;
      const bn = parseUnitsSafe(raw, VIN_DECIMALS);
      if (!bn) return;
      totalBN = totalBN.add(bn);
    });

    setText(
      $("lottoTotalBet"),
      `${formatTokenPretty(totalBN, VIN_DECIMALS, 4)} VIN`
    );
  }

  function lottoQuickHalf() {
    const rowsContainer = $("lottoRows");
    if (!rowsContainer) return;

    const rows = rowsContainer.querySelectorAll(".lotto-row");
    rows.forEach((row) => {
      const amountInput = row.querySelector(".lotto-amount");
      if (!amountInput) return;
      const raw = String(amountInput.value || "").trim();
      if (!raw) return;
      const bn = parseUnitsSafe(raw, VIN_DECIMALS);
      if (!bn) return;
      const half = bn.div(2);
      amountInput.value = formatUnitsRaw(half, VIN_DECIMALS);
    });
    refreshLottoTotalBet();
  }

  function lottoQuickDouble() {
    const rowsContainer = $("lottoRows");
    if (!rowsContainer) return;

    const rows = rowsContainer.querySelectorAll(".lotto-row");
    rows.forEach((row) => {
      const amountInput = row.querySelector(".lotto-amount");
      if (!amountInput) return;
      const raw = String(amountInput.value || "").trim();
      if (!raw) return;
      const bn = parseUnitsSafe(raw, VIN_DECIMALS);
      if (!bn) return;
      const dbl = bn.mul(2);
      amountInput.value = formatUnitsRaw(dbl, VIN_DECIMALS);
    });
    refreshLottoTotalBet();
  }

  function lottoQuickClear() {
    const rowsContainer = $("lottoRows");
    if (!rowsContainer) return;

    const rows = rowsContainer.querySelectorAll(".lotto-row");
    rows.forEach((row) => {
      const numInput = row.querySelector(".lotto-number");
      const amountInput = row.querySelector(".lotto-amount");
      if (numInput) numInput.value = "";
      if (amountInput) amountInput.value = "";
    });
    refreshLottoTotalBet();
  }

  async function lottoApprove() {
    if (!vinWrite || !currentAccount) {
      alert("Connect your wallet first.");
      return;
    }

    const statusId = "lottoStatus";
    setStatus(statusId, "Sending approval transaction for Lotto...");

    try {
      const approveAmountBN = window.ethers.utils.parseUnits(
        LOTTO_APPROVE_AMOUNT,
        VIN_DECIMALS
      );

      const tx = await sendTxWithFixedGas(
        (g) =>
          vinWrite.approve(LOTTO_CONTRACT_ADDRESS, approveAmountBN, { gasLimit: g }),
        bnGas(GAS_APPROVE)
      );

      setStatus(statusId, "Waiting for confirmation...");
      await tx.wait();

      setStatus(statusId, "Lotto approval successful.");
      await refreshAllBalancesAndPools();
    } catch (err) {
      console.error("lottoApprove error:", err);
      if (err.code === 4001) {
        setStatus(statusId, "User rejected approval transaction.");
      } else {
        const reason = extractRevertReason(err);
        setStatus(statusId, `Lotto approval failed. ${reason ? reason : ""}`.trim());
      }
    }
  }

  async function lottoPlay() {
    if (!lottoWrite || !currentAccount || !vinRead) {
      alert("Connect your wallet first.");
      return;
    }

    const statusId = "lottoStatus";
    const rowsContainer = $("lottoRows");
    if (!rowsContainer) return;

    const rows = rowsContainer.querySelectorAll(".lotto-row");
    if (!rows.length) {
      alert("Add at least one bet row.");
      return;
    }

    const bets = [];
    let totalBetBN = window.ethers.BigNumber.from(0);

    // Validate rows
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      row.classList.remove("lotto-error");

      const numInput = row.querySelector(".lotto-number");
      const amountInput = row.querySelector(".lotto-amount");
      const radios = row.querySelectorAll('input[type="radio"]');

      const numRaw = String((numInput && numInput.value) || "").trim();
      const amtRaw = String((amountInput && amountInput.value) || "").trim();

      if (!numRaw && !amtRaw) continue;

      const numVal = parseInt(numRaw, 10);
      if (isNaN(numVal) || numVal < 0 || numVal > 99) {
        row.classList.add("lotto-error");
        alert("Each number must be between 00 and 99.");
        return;
      }

      const amtBN = parseUnitsSafe(amtRaw, VIN_DECIMALS);
      if (!amtBN || amtBN.lte(0)) {
        row.classList.add("lotto-error");
        alert("Each bet amount must be greater than 0.");
        return;
      }

      let betType = 0; // 0 = BetOne, 1 = Bet27
      radios.forEach((r) => {
        if (r.checked && r.value === "bet27") betType = 1;
      });

      bets.push({
        number: numVal,
        amount: amtBN,
        betType: betType
      });

      totalBetBN = totalBetBN.add(amtBN);
    }

    if (!bets.length) {
      alert("No valid bets in the table.");
      return;
    }

    // Min bet per row
    try {
      const minBet = await lottoRead.MIN_BET();
      for (const b of bets) {
        if (b.amount.lt(minBet)) {
          alert(
            `Each bet must be at least ${formatTokenPretty(minBet, VIN_DECIMALS, 4)} VIN.`
          );
          return;
        }
      }
    } catch (err) {
      console.warn("Failed to read MIN_BET for Lotto:", err);
    }

    setStatus(
      statusId,
      `Sending Lotto transaction (rows: ${bets.length}, total: ${formatTokenPretty(
        totalBetBN,
        VIN_DECIMALS,
        4
      )} VIN)...`
    );

    try {
      const rowsCount = bets.length;
      const base = bnGas(GAS_LOTTO_PLAY_BASE);
      const per = bnGas(GAS_LOTTO_PLAY_PER_ROW).mul(rowsCount);
      const cap = bnGas(GAS_LOTTO_PLAY_CAP);
      const gasLimit = capGas(base.add(per), cap);

      const tx = await sendTxWithFixedGas(
        (g) => lottoWrite.play(bets, { gasLimit: g }),
        gasLimit
      );

      setStatus(statusId, "Waiting for confirmation...");
      const receipt = await tx.wait();

      setStatus(statusId, "Lotto played successfully ✅");
      setHTML(
        "lottoResultDetail",
        `<div><b>Tx:</b> ${receipt.transactionHash}</div>
         <div><b>Rows:</b> ${bets.length}</div>
         <div><b>Total Bet:</b> ${formatTokenPretty(totalBetBN, VIN_DECIMALS, 4)} VIN</div>
         <div style="margin-top:6px;color:#9ca3af;">(Decode using the hash box if your contract emits detailed events.)</div>`
      );

      await refreshAllBalancesAndPools();
    } catch (err) {
      console.error("lottoPlay error:", err);
      if (err.code === 4001) {
        setStatus(statusId, "User rejected transaction.");
      } else {
        const reason = extractRevertReason(err);
        setStatus(
          statusId,
          `Lotto play failed. ${reason ? reason : "This bet might revert."}`.trim()
        );
      }
    }
  }

  async function decodeLottoTx() {
    if (!ethProvider) {
      alert("Connect wallet first.");
      return;
    }
    const input = $("lottoTxHashInput");
    const txHash = String((input && input.value) || "").trim();
    if (!txHash || !/^0x([A-Fa-f0-9]{64})$/.test(txHash)) {
      alert("Paste a valid transaction hash.");
      return;
    }

    setStatus("lottoStatus", "Decoding transaction...");
    try {
      const receipt = await ethProvider.getTransactionReceipt(txHash);
      if (!receipt) {
        setStatus("lottoStatus", "Receipt not found yet.");
        return;
      }

      const iface = new window.ethers.utils.Interface(LOTTO_ABI);
      const decoded = [];

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== LOTTO_CONTRACT_ADDRESS.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog(log);
          decoded.push(parsed);
        } catch {
          // ignore unknown logs
        }
      }

      if (!decoded.length) {
        setHTML(
          "lottoResultDetail",
          `<div><b>Tx:</b> ${txHash}</div><div>No Lotto events found (ABI/event mismatch or contract doesn't emit). You can still verify on explorer.</div>`
        );
      } else {
        const parts = decoded
          .map((d) => `<div><b>${d.name}</b>: ${JSON.stringify(d.args)}</div>`)
          .join("");
        setHTML(
          "lottoResultDetail",
          `<div><b>Tx:</b> ${txHash}</div>${parts}`
        );
      }

      setStatus("lottoStatus", "Decode done.");
    } catch (err) {
      console.error("decodeLottoTx error:", err);
      setStatus("lottoStatus", "Decode failed. Check console.");
    }
  }

  function initLottoEvents() {
    const addRowBtn = $("addLottoRow");
    const approveBtn = $("lottoApproveButton");
    const playBtn = $("lottoPlayButton");

    const halfBtn = $("lottoHalf");
    const doubleBtn = $("lottoDouble");
    const clearBtn = $("lottoClear");

    const decodeBtn = $("decodeLottoTx");

    if (addRowBtn)
      addRowBtn.addEventListener("click", () => {
        createLottoRow();
        refreshLottoTotalBet();
      });

    if (approveBtn)
      approveBtn.addEventListener("click", async () => {
        await lottoApprove();
      });

    if (playBtn)
      playBtn.addEventListener("click", async () => {
        await lottoPlay();
      });

    if (halfBtn) halfBtn.addEventListener("click", lottoQuickHalf);
    if (doubleBtn) doubleBtn.addEventListener("click", lottoQuickDouble);
    if (clearBtn) clearBtn.addEventListener("click", lottoQuickClear);

    if (decodeBtn) decodeBtn.addEventListener("click", decodeLottoTx);

    // Remove row handler (event delegation)
    const rowsContainer = $("lottoRows");
    if (rowsContainer) {
      rowsContainer.addEventListener("click", (e) => {
        const t = e.target;
        if (!t) return;

        if (t.classList && t.classList.contains("btn-remove-row")) {
          const row = t.closest(".lotto-row");
          if (row && rowsContainer.children.length > 1) {
            row.remove();
            refreshLottoTotalBet();
          }
        }
      });

      // Update total on input
      rowsContainer.addEventListener("input", (e) => {
        const t = e.target;
        if (!t) return;
        if (
          t.classList.contains("lotto-amount") ||
          t.classList.contains("lotto-number")
        ) {
          refreshLottoTotalBet();
        }
      });

      rowsContainer.addEventListener("change", () => {
        refreshLottoTotalBet();
      });
    }

    refreshLottoTotalBet();
  }

  /* ========================
        WALLET BUTTONS
  ======================== */

  function initWalletEvents() {
    const btn = $("connectButton");
    if (btn) btn.addEventListener("click", connectWallet);
  }

  /* ========================
        INIT
  ======================== */

  async function initApp() {
    try {
      initReadProvider();
      setNetworkStatus(false);

      initNav();
      initSwapEvents();
      initDiceEvents();
      initLottoEvents();
      initWalletEvents();

      await updateDicePool();
      await updateLottoPool();
      updateDiceLastResultUI();
    } catch (err) {
      console.error("initApp error:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
