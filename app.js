(() => {
  "use strict";

  /* =========================
     CONFIG
  ========================== */
  const CHAIN_ID_DEC = 143;
  const CHAIN_ID_HEX = "0x8f"; // 143
  const CHAIN_NAME = "Monad";
  const RPC_URL = "https://rpc.monad.xyz";

  // Addresses (updated with new contracts)
  const ADDR_VIN = "0x038A2f1abe221d403834aa775669169Ef5eb120A"; // VIN token
  const ADDR_SWAP = "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB"; // Swap contract
  const ADDR_DICE = "0xB8D7D799eE31FedD38e63801419782E8110326E4"; // New Dice contract address
  const ADDR_LOTTO = "0x59348366C6724EbBB16d429A2af57cC0b2E34A75"; // New Lotto contract address

  // Fixed rate used by UI
  // VIN ↔ MON (your UI assumes 1 VIN = 100 MON)
  const MON_PER_VIN = 100;

  // Default approval (keep as your UI button text: 1,000,000 VIN)
  const DEFAULT_APPROVE_VIN = "1000000";

  // Price chip: VIN/USD derived from MON/USD / 100
  const COINGECKO_URL =
    "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd";

  /* =========================
     ABIs (updated with new contracts)
  ========================== */
  const ERC20_ABI = [
    "function name() view returns(string)",
    "function symbol() view returns(string)",
    "function decimals() view returns(uint8)",
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
  ];

  const SWAP_ABI = [
    "function swapVINtoMON(uint256 vinAmount)",
    "function swapMONtoVIN() payable",
  ];

  // Updated VINDice ABI (matches the new ABI you provided)
  const DICE_ABI = [
    "event Played(address indexed player,uint256 amount,uint8 choice,uint8 diceResult,uint16 roll,bool won)",
    "function play(uint256 amount, uint8 choice, uint256 clientSeed)",
    "function MIN_BET() view returns(uint256)",
    "function MAX_BET() view returns(uint256)",
    "function maxBetAllowed(address player) view returns(uint256)",
  ];

  // Updated VINLottoV1 ABI (matches the new ABI you provided)
  const LOTTO_ABI = [
    "event Played(address indexed player,bool bet27,uint8[] numbers,uint256[] amounts,uint8[27] results,uint256 totalBet,uint256 totalPayout)",
    "function play(bool bet27, uint8[] numbers, uint256[] amounts)",
    "function MIN_BET() view returns(uint256)",
  ];

  /* =========================
     DOM HELPERS
  ========================== */
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function setText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function shortAddr(a) {
    if (!a) return "-";
    return a.slice(0, 6) + "..." + a.slice(-4);
  }

  function safeNumStr(s) {
    return (s || "").toString().trim().replace(/,/g, "");
  }

  function isFiniteNumberString(s) {
    const x = safeNumStr(s);
    if (!x) return false;
    return /^(\d+(\.\d+)?)$/.test(x);
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function formatUnits(bn, decimals, maxFrac = 4) {
    try {
      const v = ethers.utils.formatUnits(bn || 0, decimals);
      const n = Number(v);
      if (!Number.isFinite(n)) return v;
      return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
    } catch {
      return "0";
    }
  }

  function formatEther(bn, maxFrac = 4) {
    try {
      const v = ethers.utils.formatEther(bn || 0);
      const n = Number(v);
      if (!Number.isFinite(n)) return v;
      return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
    } catch {
      return "0";
    }
  }

  function setStatus(el, msg, type = "") {
    if (!el) return;
    el.classList.remove("good", "bad");
    if (type === "good") el.classList.add("good");
    if (type === "bad") el.classList.add("bad");
    el.textContent = msg;
  }

  function extractRevertReason(err) {
    try {
      const e = err || {};
      const msg = (e?.error?.message || e?.data?.message || e?.message || "").toString();
      // common patterns:
      // "execution reverted: <reason>"
      const m = msg.match(/execution reverted(?::\s*)?(.+)?/i);
      if (m && m[1]) return m[1].trim();
      // "reverted with reason string '<reason>'"
      const m2 = msg.match(/reason string ['"](.+?)['"]/i);
      if (m2 && m2[1]) return m2[1].trim();
      return "";
    } catch {
      return "";
    }
  }

  /* =========================
     GLOBAL STATE
  ========================== */
  let provider = null;
  let signer = null;
  let account = null;

  let vinRead = null;
  let vinWrite = null;
  let swapWrite = null;
  let diceRead = null;
  let diceWrite = null;
  let lottoRead = null;
  let lottoWrite = null;

  let VIN_DECIMALS = 18;

  // UI state
  let currentScreen = "home-screen";
  let swapMode = "VIN_TO_MON"; // or "MON_TO_VIN"
  let diceChoice = 0; // 0 EVEN, 1 ODD

  let lottoBet27 = false; // false = BetOne, true = Bet27

  // tx locks (prevent double click / nonce issues)
  let txLock = {
    connect: false,
    swap: false,
    swapApprove: false,
    dicePlay: false,
    diceApprove: false,
    lottoPlay: false,
    lottoApprove: false,
  };

  /* =========================
     NETWORK UI
  ========================== */
  function setNetworkUI(connected, name = "") {
    const dot = $("networkDot");
    const lbl = $("networkName");
    if (dot) {
      dot.classList.toggle("dot-connected", !!connected);
      dot.classList.toggle("dot-disconnected", !connected);
    }
    if (lbl) lbl.textContent = connected ? (name || CHAIN_NAME) : "Not connected";
  }

  function setConnectButtonUI(connected, addr = "") {
    const btn = $("connectBtn");
    if (!btn) return;
    btn.classList.toggle("connected", !!connected);
    btn.textContent = connected ? shortAddr(addr) : "Connect";
    btn.title = connected ? addr : "Connect wallet";
  }

  /* =========================
     SCREEN NAVIGATION
  ========================== */
  function showScreen(screenId) {
    const ids = ["home-screen", "swap-screen", "dice-screen", "lotto-screen"];
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.classList.toggle("screen-active", id === screenId);
    });

    // nav active
    const navMap = {
      "home-screen": "navHome",
      "swap-screen": "navSwap",
      "dice-screen": "navDice",
      "lotto-screen": "navLotto",
    };
    Object.values(navMap).forEach((btnId) => {
      const b = $(btnId);
      if (b) b.classList.remove("active");
    });
    const activeBtn = $(navMap[screenId]);
    if (activeBtn) activeBtn.classList.add("active");

    currentScreen = screenId;
  }

  /* =========================
     ETHERS — SAFE INIT
     (Fresh provider/signer for tx)
  ========================== */
  async function ensureProvider() {
    if (!window.ethereum) throw new Error("No wallet");
    if (!provider) provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    return provider;
  }

  async function ensureConnected({ silent = false } = {}) {
    if (txLock.connect) return false;
    txLock.connect = true;
    try {
      if (!window.ethereum) {
        alert("MetaMask not found");
        return false;
      }

      // request accounts if not silent
      let accs = [];
      if (silent) {
        accs = await window.ethereum.request({ method: "eth_accounts" });
        if (!accs || !accs.length) return false;
      } else {
        accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      }

      // switch chain
      const cid = await window.ethereum.request({ method: "eth_chainId" });
      if (cid !== CHAIN_ID_HEX) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: CHAIN_ID_HEX }],
          });
        } catch (e) {
          // If chain not added, you can add it (optional)
          // We'll just show a clean message.
          alert("Please switch your wallet network to Monad (chainId 143).");
          return false;
        }
      }

      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      signer = provider.getSigner();
      account = accs[0];

      setNetworkUI(true, CHAIN_NAME);
      setConnectButtonUI(true, account);

      // update wallet labels in UI
      setText("walletShort", shortAddr(account));
      setText("homeNetwork", CHAIN_NAME);
      setText("diceWalletShort", shortAddr(account));
      setText("lottoWallet", shortAddr(account));

      await initContracts();
      return true;
    } catch (err) {
      if (!silent) {
        console.error(err);
        alert("Connect failed or rejected.");
      }
      return false;
    } finally {
      txLock.connect = false;
    }
  }

  async function initContracts() {
    if (!provider) return;

    // read contracts with provider
    vinRead = new ethers.Contract(ADDR_VIN, ERC20_ABI, provider);
    diceRead = new ethers.Contract(ADDR_DICE, DICE_ABI, provider);
    lottoRead = new ethers.Contract(ADDR_LOTTO, LOTTO_ABI, provider);

    // write contracts with signer
    if (signer) {
      vinWrite = new ethers.Contract(ADDR_VIN, ERC20_ABI, signer);
      swapWrite = new ethers.Contract(ADDR_SWAP, SWAP_ABI, signer);
      diceWrite = new ethers.Contract(ADDR_DICE, DICE_ABI, signer);
      lottoWrite = new ethers.Contract(ADDR_LOTTO, LOTTO_ABI, signer);
    }

    // decimals
    try {
      VIN_DECIMALS = await vinRead.decimals();
    } catch {
      VIN_DECIMALS = 18;
    }
  }

  /* =========================
     BALANCES / ALLOWANCES / POOLS
  ========================== */
  async function refreshAll() {
    if (!provider || !vinRead) return;

    // Home hints
    const homeHint = $("homeHint");
    if (!account) {
      if (homeHint) homeHint.textContent = "Connect your wallet to load balances.";
      return;
    }
    if (homeHint) homeHint.textContent = "Balances loaded from chain.";

    // balances
    try {
      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(account),
        provider.getBalance(account),
      ]);

      setText("homeVinBal", `${formatUnits(vinBal, VIN_DECIMALS, 4)} VIN`);
      setText("homeMonBal", `${formatEther(monBal, 4)} MON`);

      setText("diceVinBal", `${formatUnits(vinBal, VIN_DECIMALS, 4)} VIN`);
      setText("diceMonBal", `${formatEther(monBal, 4)} MON`);

      setText("lottoVinBalance", `${formatUnits(vinBal, VIN_DECIMALS, 4)} VIN`);
    } catch (e) {
      console.error("refresh balances error:", e);
    }

    // allowances
    try {
      const [allowDice, allowLotto, allowSwap] = await Promise.all([
        vinRead.allowance(account, ADDR_DICE),
        vinRead.allowance(account, ADDR_LOTTO),
        vinRead.allowance(account, ADDR_SWAP),
      ]);

      setText("diceAllowance", `${formatUnits(allowDice, VIN_DECIMALS, 4)} VIN`);
      setText("lottoAllowance", `${formatUnits(allowLotto, VIN_DECIMALS, 4)} VIN`);

      // swap UI uses same approve btn; show value on swap page by balances area
      // (not required, but good)
    } catch (e) {
      console.error("allowance error:", e);
    }

    // pools
    try {
      // Dice pool = VIN balance of Dice contract
      const [dicePool, lottoPool] = await Promise.all([
        vinRead.balanceOf(ADDR_DICE),
        vinRead.balanceOf(ADDR_LOTTO),
      ]);

      setText("homeDicePool", `${formatUnits(dicePool, VIN_DECIMALS, 4)} VIN`);
      setText("dicePool", `${formatUnits(dicePool, VIN_DECIMALS, 4)} VIN`);

      setText("homeLottoPool", `${formatUnits(lottoPool, VIN_DECIMALS, 4)} VIN`);
      setText("lottoPool", `${formatUnits(lottoPool, VIN_DECIMALS, 4)} VIN`);
    } catch (e) {
      console.error("pool error:", e);
    }

    // min/max bet hints (dice/lotto)
    try {
      const [min, max, maxAllowed] = await Promise.all([
        diceRead.MIN_BET(),
        diceRead.MAX_BET(),
        diceRead.maxBetAllowed(account),
      ]);
      const minS = formatUnits(min, VIN_DECIMALS, 6);
      const maxS = formatUnits(max, VIN_DECIMALS, 0);
      const allowS = formatUnits(maxAllowed, VIN_DECIMALS, 0);
      setText("diceMinMax", `Min ${minS} / Max ${maxS} (Allowed ${allowS})`);
    } catch (_) {}

    try {
      const minL = await lottoRead.MIN_BET();
      // No direct UI element for min in HTML, keep status hints only.
      // You can show it inside lottoStatus when playing.
      void minL;
    } catch (_) {}

    // swap balances label
    refreshSwapBalanceLabels();
    // lotto total
    computeLottoTotal();
  }
  
  /* =========================
     SWAP UI
  ========================== */
  function setSwapMode(mode) {
    swapMode = mode;

    const tabVinToMon = $("swapTabVinToMon");
    const tabMonToVin = $("swapTabMonToVin");
    if (tabVinToMon) tabVinToMon.classList.toggle("active", mode === "VIN_TO_MON");
    if (tabMonToVin) tabMonToVin.classList.toggle("active", mode === "MON_TO_VIN");

    const fromTok = $("swapFromToken");
    const toTok = $("swapToToken");
    if (fromTok) fromTok.textContent = mode === "VIN_TO_MON" ? "VIN" : "MON";
    if (toTok) toTok.textContent = mode === "VIN_TO_MON" ? "MON" : "VIN";

    // reset fields
    const fromAmt = $("swapFromAmt");
    const toAmt = $("swapToAmt");
    if (fromAmt) fromAmt.value = "";
    if (toAmt) toAmt.value = "";
    refreshSwapBalanceLabels();
    setStatus($("swapStatus"), "Waiting for your action...");
  }

  async function refreshSwapBalanceLabels() {
    const fromBal = $("swapFromBal");
    const toBal = $("swapToBal");
    if (!fromBal || !toBal) return;

    if (!account || !provider || !vinRead) {
      fromBal.textContent = "Balance: -";
      toBal.textContent = "Balance: -";
      return;
    }

    try {
      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(account),
        provider.getBalance(account),
      ]);

      if (swapMode === "VIN_TO_MON") {
        fromBal.textContent = `Balance: ${formatUnits(vinBal, VIN_DECIMALS, 4)} VIN`;
        toBal.textContent = `Balance: ${formatEther(monBal, 4)} MON`;
      } else {
        fromBal.textContent = `Balance: ${formatEther(monBal, 4)} MON`;
        toBal.textContent = `Balance: ${formatUnits(vinBal, VIN_DECIMALS, 4)} VIN`;
      }
    } catch {
      fromBal.textContent = "Balance: -";
      toBal.textContent = "Balance: -";
    }
  }

  function computeSwapTo() {
    const fromAmtEl = $("swapFromAmt");
    const toAmtEl = $("swapToAmt");
    if (!fromAmtEl || !toAmtEl) return;

    const v = safeNumStr(fromAmtEl.value);
    if (!isFiniteNumberString(v)) {
      toAmtEl.value = "";
      return;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      toAmtEl.value = "";
      return;
    }

    if (swapMode === "VIN_TO_MON") {
      toAmtEl.value = (n * MON_PER_VIN).toString();
    } else {
      toAmtEl.value = (n / MON_PER_VIN).toString();
    }
  }

  async function swapMax() {
    if (!account || !provider || !vinRead) return;
    const fromAmtEl = $("swapFromAmt");
    if (!fromAmtEl) return;

    try {
      if (swapMode === "VIN_TO_MON") {
        const vinBal = await vinRead.balanceOf(account);
        fromAmtEl.value = ethers.utils.formatUnits(vinBal, VIN_DECIMALS);
      } else {
        const monBal = await provider.getBalance(account);
        // keep some gas buffer
        const buf = ethers.utils.parseEther("0.001");
        const val = monBal.gt(buf) ? monBal.sub(buf) : ethers.constants.Zero;
        fromAmtEl.value = ethers.utils.formatEther(val);
      }
      computeSwapTo();
    } catch {}
  }

  async function approveVin(spender, statusEl) {
    if (!account) {
      alert("Connect wallet first.");
      return false;
    }

    try {
      const ok = await ensureConnected({ silent: true });
      if (!ok) {
        const ok2 = await ensureConnected({ silent: false });
        if (!ok2) return false;
      }

      const amount = ethers.utils.parseUnits(DEFAULT_APPROVE_VIN, VIN_DECIMALS);
      setStatus(statusEl, "Signing approval...");
      const tx = await vinWrite.approve(spender, amount);
      setStatus(statusEl, "Waiting confirmation...");
      await tx.wait();
      setStatus(statusEl, "Approved.", "good");
      await refreshAll();
      return true;
    } catch (e) {
      console.error(e);
      const reason = extractRevertReason(e);
      setStatus(statusEl, "Approval failed. " + (reason || ""), "bad");
      alert("Approval failed or rejected.");
      return false;
    }
  }

  async function doSwap() {
    const statusEl = $("swapStatus");
    if (txLock.swap) return;
    txLock.swap = true;

    try {
      if (!account) {
        alert("Connect wallet first.");
        return;
      }

      const ok = await ensureConnected({ silent: true });
      if (!ok) {
        const ok2 = await ensureConnected({ silent: false });
        if (!ok2) return;
      }

      const fromAmtEl = $("swapFromAmt");
      if (!fromAmtEl) return;
      const v = safeNumStr(fromAmtEl.value);
      if (!isFiniteNumberString(v) || Number(v) <= 0) {
        setStatus(statusEl, "Enter a valid amount.", "bad");
        return;
      }

      if (swapMode === "VIN_TO_MON") {
        const vinAmt = ethers.utils.parseUnits(v, VIN_DECIMALS);

        // allowance check
        const allowance = await vinRead.allowance(account, ADDR_SWAP);
        if (allowance.lt(vinAmt)) {
          setStatus(statusEl, "Approval required for Swap.", "bad");
          alert("Please approve VIN for Swap first.");
          return;
        }

        setStatus(statusEl, "Signing swap...");
        const tx = await swapWrite.swapVINtoMON(vinAmt);
        setStatus(statusEl, "Waiting confirmation...");
        await tx.wait();
        setStatus(statusEl, "Swap completed.", "good");
      } else {
        // MON -> VIN
        const monValue = ethers.utils.parseEther(v);

        setStatus(statusEl, "Signing swap...");
        const tx = await swapWrite.swapMONtoVIN({ value: monValue });
        setStatus(statusEl, "Waiting confirmation...");
        await tx.wait();
        setStatus(statusEl, "Swap completed.", "good");
      }

      // refresh
      await refreshAll();
      computeSwapTo();
    } catch (e) {
      console.error(e);
      const reason = extractRevertReason(e);
      setStatus(statusEl, "Swap failed. " + (reason || ""), "bad");
      alert("Swap failed or rejected.");
    } finally {
      txLock.swap = false;
    }
  }

  /* =========================
     DICE (Even/Odd)
  ========================== */
  function setDiceChoice(c) {
    diceChoice = c;
    const evenBtn = $("diceEvenBtn");
    const oddBtn = $("diceOddBtn");
    if (evenBtn) {
      evenBtn.classList.toggle("active", c === 0);
      evenBtn.setAttribute("aria-pressed", c === 0 ? "true" : "false");
    }
    if (oddBtn) {
      oddBtn.classList.toggle("active", c === 1);
      oddBtn.setAttribute("aria-pressed", c === 1 ? "true" : "false");
    }
  }

  function setDiceShaking(on) {
    const coins = $("diceCoins");
    if (!coins) return;
    coins.classList.toggle("is-shaking", !!on);
  }

  function applyCoinColors(colors) {
    // colors length 4, each "red" or "white"
    for (let i = 0; i < 4; i++) {
      const c = $("coin" + i);
      if (!c) continue;
      c.classList.remove("coin-red", "coin-white");
      c.classList.add(colors[i] === "red" ? "coin-red" : "coin-white");
    }
  }

  function randomEvenPattern() {
    const patterns = [
      ["white", "white", "white", "white"], // 4 white
      ["red", "red", "red", "red"],         // 4 red
      ["white", "white", "red", "red"],     // 2-2 (shuffle)
    ];
    const p = patterns[Math.floor(Math.random() * patterns.length)];
    return shuffle(p);
  }

  function randomOddPattern() {
    const patterns = [
      ["red", "white", "white", "white"], // 1 red
      ["red", "red", "red", "white"],     // 3 red (shuffle)
    ];
    const p = patterns[Math.floor(Math.random() * patterns.length)];
    return shuffle(p);
  }

  function setDiceResultBox({ shownResultIsEven, choiceIsEven, won, payoutVin, txHash }) {
    const resEl = $("diceResult");
    const hashEl = $("diceHash");
    const statusEl = $("diceStatus");

    const shownResultText = shownResultIsEven ? "EVEN" : "ODD";
    const choiceText = choiceIsEven ? "EVEN" : "ODD";
    const statusText = won ? "WIN" : "LOSE";

    if (statusEl) {
      statusEl.innerHTML = won
        ? `<span class="win">WIN</span>`
        : `<span class="lose">LOSE</span>`;
    }

    if (resEl) {
      // Keep it clean and clear, no duplicate hash.
      resEl.innerHTML =
        `Result: ${shownResultText}<br>` +
        `Your choice: ${choiceText}<br>` +
        `Status: ${statusText}<br>` +
        `Payout: ${payoutVin} VIN`;
    }

    if (hashEl) {
      hashEl.textContent = txHash ? `Hash: ${txHash}` : "-";
    }
  }

  async function diceApprove() {
    const statusEl = $("diceStatus");
    if (txLock.diceApprove) return;
    txLock.diceApprove = true;
    try {
      await approveVin(ADDR_DICE, statusEl);
    } finally {
      txLock.diceApprove = false;
    }
  }

  async function dicePlay() {
    const statusEl = $("diceStatus");
    const betEl = $("diceBetAmt");
    const playBtn = $("dicePlayBtn");

    if (txLock.dicePlay) return;
    txLock.dicePlay = true;

    try {
      if (!account) {
        alert("Connect wallet first.");
        setStatus(statusEl, "Connect wallet first.", "bad");
        return;
      }

      const ok = await ensureConnected({ silent: true });
      if (!ok) {
        const ok2 = await ensureConnected({ silent: false });
        if (!ok2) return;
      }

      const v = safeNumStr(betEl ? betEl.value : "");
      if (!isFiniteNumberString(v) || Number(v) <= 0) {
        setStatus(statusEl, "Enter a valid bet amount.", "bad");
        return;
      }

      const amountBN = ethers.utils.parseUnits(v, VIN_DECIMALS);

      // min/max check from contract to avoid revert
      let minBet = null;
      let maxBet = null;
      let maxAllowed = null;
      try {
        [minBet, maxBet, maxAllowed] = await Promise.all([
          diceRead.MIN_BET(),
          diceRead.MAX_BET(),
          diceRead.maxBetAllowed(account),
        ]);
      } catch (_) {}

      if (minBet && amountBN.lt(minBet)) {
        setStatus(statusEl, `Bet too small. Min is ${formatUnits(minBet, VIN_DECIMALS, 6)} VIN.`, "bad");
        return;
      }
      if (maxBet && amountBN.gt(maxBet)) {
        setStatus(statusEl, `Bet too large. Max is ${formatUnits(maxBet, VIN_DECIMALS, 0)} VIN.`, "bad");
        return;
      }
      if (maxAllowed && amountBN.gt(maxAllowed)) {
        setStatus(statusEl, `Bet exceeds your allowed max (${formatUnits(maxAllowed, VIN_DECIMALS, 0)} VIN).`, "bad");
        return;
      }

      // allowance check
      const allowance = await vinRead.allowance(account, ADDR_DICE);
      if (allowance.lt(amountBN)) {
        setStatus(statusEl, "Approval required for Dice.", "bad");
        alert("Please approve VIN for Dice first.");
        return;
      }

      // UI lock & shaking
      if (playBtn) playBtn.disabled = true;
      setDiceShaking(true);
      setStatus(statusEl, "Signing...");

      // clientSeed: use time + random
      const clientSeed = BigInt(Date.now()) ^ (BigInt(Math.floor(Math.random() * 1e9)) << 16n);

      const tx = await diceWrite.play(amountBN, diceChoice, clientSeed.toString());
      setStatus(statusEl, "Waiting result...");

      const receipt = await tx.wait();

      // parse Played event
      let played = null;
      try {
        for (const log of receipt.logs) {
          if (log.address && log.address.toLowerCase() === ADDR_DICE.toLowerCase()) {
            const parsed = diceWrite.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              played = parsed;
              break;
            }
          }
        }
      } catch (e) {
        console.error("parse dice event error:", e);
      }

      if (!played) {
        setDiceShaking(false);
        setStatus(statusEl, "Confirmed. (No event parsed)", "good");
        setDiceResultBox({
          shownResultIsEven: true,
          choiceIsEven: diceChoice === 0,
          won: false,
          payoutVin: "0",
          txHash: receipt.transactionHash,
        });
        await refreshAll();
        return;
      }

      const won = !!played.args.won;
      const choiceIsEven = Number(played.args.choice) === 0;

      const shownResultIsEven = won ? choiceIsEven : !choiceIsEven;
      const colors = shownResultIsEven ? randomEvenPattern() : randomOddPattern();
      applyCoinColors(colors);

      const payoutVin = won ? formatUnits(amountBN.mul(2), VIN_DECIMALS, 4) : "0";

      setDiceResultBox({
        shownResultIsEven,
        choiceIsEven,
        won,
        payoutVin,
        txHash: receipt.transactionHash,
      });

      setStatus(statusEl, won ? "WIN" : "LOSE", won ? "good" : "bad");

      await refreshAll();
    } catch (e) {
      console.error(e);
      const reason = extractRevertReason(e);
      setDiceShaking(false);
      setStatus(statusEl, "Dice play failed. " + (reason || ""), "bad");
      alert("Dice play failed or rejected.");
    } finally {
      setDiceShaking(false);
      if (playBtn) playBtn.disabled = false;
      txLock.dicePlay = false;
    }
  }

  /* =========================
     LOTTO
  ========================== */
  async function lottoApprove() {
    const statusEl = $("lottoStatus");
    if (txLock.lottoApprove) return;
    txLock.lottoApprove = true;
    try {
      await approveVin(ADDR_LOTTO, statusEl);
    } finally {
      txLock.lottoApprove = false;
    }
  }

  async function lottoPlay() {
    const statusEl = $("lottoStatus");
    const playBtn = $("lottoPlayBtn");
    if (txLock.lottoPlay) return;
    txLock.lottoPlay = true;

    try {
      if (!account) {
        alert("Connect wallet first.");
        setStatus(statusEl, "Connect wallet first.", "bad");
        return;
      }

      const ok = await ensureConnected({ silent: true });
      if (!ok) {
        const ok2 = await ensureConnected({ silent: false });
        if (!ok2) return;
      }

      // build numbers/amounts from rows
      const rows = getLottoRows();
      const numbers = [];
      const amounts = [];
      let totalHuman = 0;

      for (const r of rows) {
        const numEl = qs(".lottoNumber", r);
        const amtEl = qs(".lottoAmount", r);

        const n = normalizeLottoNumber(numEl ? numEl.value : "");
        const aStr = normalizeLottoAmount(amtEl ? amtEl.value : "");

        if (n === null || !aStr) {
          setStatus(statusEl, "Invalid rows. Check number (00–99) and bet amount.", "bad");
          return;
        }

        numbers.push(n);
        amounts.push(ethers.utils.parseUnits(aStr, VIN_DECIMALS));
        totalHuman += Number(aStr);
      }

      if (!numbers.length) {
        setStatus(statusEl, "Add at least one row.", "bad");
        return;
      }

      // min bet check from contract (totalBet must be >= MIN_BET)
      try {
        const min = await lottoRead.MIN_BET();
        const totalBN = amounts.reduce((acc, x) => acc.add(x), ethers.constants.Zero);
        if (totalBN.lt(min)) {
          setStatus(statusEl, `Total bet too small. Min is ${formatUnits(min, VIN_DECIMALS, 6)} VIN.`, "bad");
          return;
        }
      } catch (_) {}

      // allowance check (need >= total)
      const totalBN2 = amounts.reduce((acc, x) => acc.add(x), ethers.constants.Zero);
      const allowance = await vinRead.allowance(account, ADDR_LOTTO);
      if (allowance.lt(totalBN2)) {
        setStatus(statusEl, "Approval required for Lotto.", "bad");
        alert("Please approve VIN for Lotto first.");
        return;
      }

      // lock UI
      if (playBtn) playBtn.disabled = true;
      setStatus(statusEl, "Signing...");

      // bet27 flag
      const bet27 = !!lottoBet27;

      const tx = await lottoWrite.play(bet27, numbers, amounts);
      setStatus(statusEl, "Waiting result...");

      const receipt = await tx.wait();

      // parse Played event
      let played = null;
      try {
        for (const log of receipt.logs) {
          if (log.address && log.address.toLowerCase() === ADDR_LOTTO.toLowerCase()) {
            const parsed = lottoWrite.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              played = parsed;
              break;
            }
          }
        }
      } catch (e) {
        console.error("parse lotto event error:", e);
      }

      if (!played) {
        setStatus(statusEl, "Confirmed. (No event parsed)", "good");
        setText("lottoHash", `Hash: ${receipt.transactionHash}`);
        await refreshAll();
        return;
      }

      const totalBet = played.args.totalBet;
      const totalPayout = played.args.totalPayout;
      const results = played.args.results; // uint8[27]

      setText("lottoHash", `Hash: ${receipt.transactionHash}`);

      // summary
      const numsStr = numbers.map((n) => n.toString().padStart(2, "0")).join(", ");
      const totalBetStr = formatUnits(totalBet, VIN_DECIMALS, 4);
      const totalPayoutStr = formatUnits(totalPayout, VIN_DECIMALS, 4);

      setText(
        "lottoBetSummary",
        `${bet27 ? "Bet27" : "BetOne"} | Numbers: ${numsStr} | Total: ${totalBetStr} VIN`
      );

      renderLottoResults(Array.from(results).map((x) => Number(x)));

      // outcome
      const won = totalPayout.gt(0);
      setText("lottoOutcome", won ? "WIN" : "LOSE");
      setText("lottoWinLoss", won ? `Payout: ${totalPayoutStr} VIN` : "Payout: 0 VIN");

      setStatus(statusEl, won ? "WIN" : "LOSE", won ? "good" : "bad");

      await refreshAll();
    } catch (e) {
      console.error(e);
      const reason = extractRevertReason(e);
      setStatus(statusEl, "Lotto play failed. " + (reason || ""), "bad");
      alert("Lotto play failed or rejected.");
    } finally {
      if (playBtn) playBtn.disabled = false;
      txLock.lottoPlay = false;
    }
  }

  /* =========================
     INITIALIZE
  ========================== */
  async function init() {
    // connect to wallet & show screen
    await ensureConnected();
    showScreen("home-screen");
    updateVinUsdChip();
    await refreshAll();
  }

  // wait for page to load
  window.addEventListener("load", async () => {
    await init();
  });
})();
