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
  // Minimal ABIs (embedded)
  // -----------------------------
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];

  const SWAP_ABI = [
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

  // Dice shaking controller
  let diceShakeTimer = null;
  let diceShakeRunning = false;

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

  function setWinLoseClass(el, won) {
    if (!el) return;
    el.classList.remove("win", "lose");
    el.classList.add(won ? "win" : "lose");
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
  // Chain / Wallet readiness
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

  // This function is the “fix” for your issue #1:
  // It ensures chain, provider/signer/contracts are ready BEFORE we send tx,
  // and “wakes up” MetaMask once to avoid first-play random failure.
  async function ensureReadyForTx() {
    if (!window.ethereum) {
      alert("MetaMask not found.");
      return false;
    }

    const ok = await ensureMonadChain();
    if (!ok) {
      alert("Please switch to Monad (chainId 143) in MetaMask.");
      return false;
    }

    // Always recreate provider/signer before tx (prevents stale signer issues)
    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    signer = provider.getSigner();

    // Warm-up MetaMask state (prevents first-call weirdness)
    try {
      await provider.send("eth_accounts", []);
    } catch (_) {}

    // If no account yet, request it
    try {
      const accounts = await provider.send("eth_requestAccounts", []);
      if (!accounts || !accounts.length) return false;
    } catch (e) {
      return false;
    }

    try {
      account = await signer.getAddress();
    } catch (e) {
      return false;
    }

    // Update UI basics
    setNetworkUI(true, "Monad");
    setConnectButtonUI(true, account);
    setText("walletShort", shortAddr(account));
    setText("homeNetwork", "Monad");
    setText("diceWalletShort", shortAddr(account));
    setText("lottoWallet", shortAddr(account));

    await initContracts();
    return true;
  }

  async function connectWallet() {
    const ok = await ensureReadyForTx();
    if (!ok) return;
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

    const [monBal, vinBal] = await Promise.all([
      provider.getBalance(account),
      vinRead.balanceOf(account),
    ]);

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
    if (!vinRead) return;

    const [diceVin, lottoVin] = await Promise.all([
      vinRead.balanceOf(ADDR_DICE),
      vinRead.balanceOf(ADDR_LOTTO),
    ]);

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
        `Min ${formatUnitsSafe(minB, vinDecimals, 6)} / Max ${formatUnitsSafe(maxB, vinDecimals, 4)}`
      );
    } catch (_) {
      // fallback text if contract read fails
      setText("diceMinMax", "Min - / Max -");
    }
  }

  async function refreshAll() {
    await Promise.allSettled([
      refreshPools(),
      refreshBalances(),
      refreshAllowances(),
      refreshDiceLimits(),
    ]);

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
    const ok = await ensureReadyForTx();
    if (!ok) {
      alert("Please connect wallet first.");
      return;
    }
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
    const ok = await ensureReadyForTx();
    if (!ok) {
      alert("Please connect wallet first.");
      return;
    }
    if (!swapWrite || !account || !provider) return;

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

  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function randomEvenPattern() {
    // EVEN types: 4 white, 4 red, 2-2 (shuffled)
    const pick = Math.floor(Math.random() * 3);
    if (pick === 0) return ["white", "white", "white", "white"];
    if (pick === 1) return ["red", "red", "red", "red"];
    // 2 white + 2 red, shuffle positions
    return shuffleArray(["white", "white", "red", "red"]);
  }

  function randomOddPattern() {
    // ODD types: 1 red, 3 red (shuffled)
    const pick = Math.floor(Math.random() * 2);
    if (pick === 0) return shuffleArray(["red", "white", "white", "white"]); // 1 red
    return shuffleArray(["red", "red", "red", "white"]); // 3 red
  }

  function startDiceShake() {
    const box = $("diceCoins");
    if (!box) return;

    // Prefer CSS class "is-shaking" if your style.css uses it
    box.classList.add("is-shaking");

    // Also keep a tiny “jitter refresh” to make sure it keeps animating
    // (some browsers pause animations in rare cases)
    diceShakeRunning = true;
    if (diceShakeTimer) clearInterval(diceShakeTimer);
    diceShakeTimer = setInterval(() => {
      if (!diceShakeRunning) return;
      // Toggle a helper class to retrigger if needed
      box.classList.remove("shake");
      // force reflow
      void box.offsetWidth;
      box.classList.add("shake");
    }, 700);
  }

  function stopDiceShake() {
    const box = $("diceCoins");
    if (box) {
      box.classList.remove("is-shaking");
      box.classList.remove("shake");
    }
    diceShakeRunning = false;
    if (diceShakeTimer) {
      clearInterval(diceShakeTimer);
      diceShakeTimer = null;
    }
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

  function renderDiceResultDetail({ uiResultEven, playerChoiceEven, won, payoutBN, txHash }) {
    const resultTxt = uiResultEven ? "EVEN" : "ODD";
    const choiceTxt = playerChoiceEven ? "EVEN" : "ODD";

    const payoutVin = payoutBN ? Number(ethers.utils.formatUnits(payoutBN, vinDecimals)) : 0;
    const statusLine = won ? "WIN" : "LOSE";
    const payoutLine = won
      ? `Payout: ${payoutVin.toLocaleString(undefined, { maximumFractionDigits: 6 })} VIN`
      : "Payout: 0 VIN";

    const html =
      `<div><b>Result:</b> ${resultTxt}</div>` +
      `<div><b>Your choice:</b> ${choiceTxt}</div>` +
      `<div><b>Status:</b> <span class="${won ? "win" : "lose"}">${statusLine}</span></div>` +
      `<div><b>${payoutLine}</b></div>`;

    setHTML("diceResult", html);

    const diceResultEl = $("diceResult");
    if (diceResultEl) setWinLoseClass(diceResultEl, !!won);

    // Show a single hash line (no duplicates)
    setText("diceHash", txHash ? "Hash: " + txHash : "Hash: -");
  }

  async function doDicePlay() {
    // Fix #1: ensure everything ready before tx (prevents first-play error)
    const ok = await ensureReadyForTx();
    if (!ok) {
      alert("Please connect wallet first.");
      return;
    }
    if (!diceWrite || !account) return;

    const amtEl = $("diceBetAmt");
    const amountBN = toWeiSafe(amtEl ? amtEl.value : "", vinDecimals);
    if (!amountBN || amountBN.lte(0)) {
      alert("Invalid bet amount.");
      return;
    }

    // Reset result UI
    setText("diceStatus", "Preparing...");
    setText("diceHash", "-");
    setHTML("diceResult", "-");

    const diceResultEl = $("diceResult");
    if (diceResultEl) diceResultEl.classList.remove("win", "lose");

    // Fix #2: shake from click -> after user signs -> mined -> result
    startDiceShake();

    try {
      // Create clientSeed
      const clientSeed = Math.floor(Math.random() * 1e12);

      setText("diceStatus", "Waiting for wallet signature...");

      // Send tx (MetaMask popup happens here)
      const tx = await diceWrite.play(amountBN, diceChoice, clientSeed);

      setText("diceStatus", "Transaction sent. Waiting confirm...");

      const rc = await tx.wait();
      const txHash = rc.transactionHash || tx.hash || "-";

      // Parse Played event
      let onchainEven = null;
      let won = null;

      try {
        for (const log of rc.logs) {
          try {
            const parsed = diceRead.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              won = !!parsed.args.won;
              const diceResult = Number(parsed.args.diceResult); // 0 even / 1 odd
              onchainEven = diceResult === 0;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}

      // If event not found, fallback (avoid breaking UI)
      if (won === null) won = false;

      // UI rule: player ONLY cares about win/lose (payout).
      // - If won: show the player's chosen parity as the "Result"
      // - If lost: show the opposite parity as the "Result"
      const playerChoiceEven = diceChoice === 0;
      const uiResultEven = won ? playerChoiceEven : !playerChoiceEven;

      // Show matching coin pattern (random variants within parity)
      setCoinColors(uiResultEven ? randomEvenPattern() : randomOddPattern());

      // Payout display:
      // Contract pays 2x stake only when 'won' is true.
      const payoutBN = won ? amountBN.mul(2) : ethers.BigNumber.from(0);

      renderDiceResultDetail({
        uiResultEven,
        playerChoiceEven,
        won,
        payoutBN,
        txHash,
      });

      setText("diceStatus", "Done ✓");
      await refreshAll();
    } catch (e) {
      console.error(e);
      setText("diceStatus", "Play failed.");
      // Stop shake even if rejected
      stopDiceShake();
      alert("Dice play failed or rejected.");
      return;
    } finally {
      // Stop shake only after final outcome (or error)
      stopDiceShake();
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
    // Fix #1 also applies to Lotto
    const ok = await ensureReadyForTx();
    if (!ok) {
      alert("Please connect wallet first.");
      return;
    }
    if (!lottoWrite || !account) return;

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
      setText("lottoStatus", "Waiting for wallet signature...");
      setText("lottoHash", "-");
      setText("lottoOutcome", "-");
      setText("lottoWinLoss", "-");
      setText("lottoResultsGrid", "-");

      const tx = await lottoWrite.play(lottoBet27, numbers, amounts);
      setText("lottoStatus", "Transaction sent. Waiting confirm...");
      const rc = await tx.wait();

      const txHash = rc.transactionHash || tx.hash || "-";
      setText("lottoHash", "Hash: " + blockHash);

      // Parse Played event to get results + payout
      let results27 = null;
      let totalPayout = null;

      try {
        for (const log of rc.logs) {
          try {
            const parsed = lottoRead.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              results27 = parsed.args.results;
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

        const betInfo = lottoBet27
          ? "Bet27 applies to all 27 draws."
          : "BetOne applies only to draw #27.";
        setText("lottoOutcome", betInfo);
      } else {
        setText("lottoResultsGrid", "Results not found in logs.");
        setText("lottoOutcome", lottoBet27 ? "Bet27" : "BetOne");
      }

      // Win/Lose + payout
      let payoutVin = 0;
      if (totalPayout) payoutVin = Number(ethers.utils.formatUnits(totalPayout, vinDecimals));

      const outcomeEl = $("lottoWinLoss");
      if (outcomeEl) outcomeEl.classList.remove("win", "lose");

      const won = payoutVin > 0;
      if (won) {
        setText(
          "lottoWinLoss",
          `WIN • Payout: ${payoutVin.toLocaleString(undefined, { maximumFractionDigits: 6 })} VIN`
        );
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

    // Default coin view
    setCoinColors(randomEvenPattern());
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

    // Bind initial row sanitizers (existing rows in HTML)
    const rows = getRowEls();
    rows.forEach((row) => {
      const num = row.querySelector(".lottoNumber");
      const amt = row.querySelector(".lottoAmount");
      if (num) num.addEventListener("input", () => (num.value = clamp2Digits(num.value)));
      if (num) num.addEventListener("blur", () => normalizeNumberInput(num));
      if (amt) amt.addEventListener("input", () => refreshLottoTotal().catch(() => {}));
    });

    refreshLottoTotal().catch(() => {});
  }

  // -----------------------------
  // Ethereum events
  // -----------------------------
  function bindEthereumEvents() {
    if (!window.ethereum) return;

    window.ethereum.on("accountsChanged", async (accs) => {
      if (!accs || !accs.length) {
        disconnectUIOnly();
        return;
      }
      // Re-init quickly
      await ensureReadyForTx().catch(() => {});
      await refreshAll().catch(() => {});
    });

    window.ethereum.on("chainChanged", async () => {
      // Force re-init on chain switch
      await ensureReadyForTx().catch(() => {});
      await refreshAll().catch(() => {});
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    bindUI();
    bindEthereumEvents();
    showScreen("home-screen");

    // Try to show "connected" state if already authorized
    (async () => {
      if (!window.ethereum) return;
      try {
        const accs = await window.ethereum.request({ method: "eth_accounts" });
        if (accs && accs.length) {
          // Silent ensure (no popup)
          provider = new ethers.providers.Web3Provider(window.ethereum, "any");
          signer = provider.getSigner();
          account = accs[0];
          setNetworkUI(true, "Monad");
          setConnectButtonUI(true, account);
          setText("walletShort", shortAddr(account));
          setText("homeNetwork", "Monad");
          setText("diceWalletShort", shortAddr(account));
          setText("lottoWallet", shortAddr(account));
          await initContracts();
          await refreshAll();
        }
      } catch (_) {}
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
