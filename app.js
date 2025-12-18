// app.js - VinMonDice dApp logic (Swap & Dice)
// Network: Monad (chainId 143)
// VINTokenV2: 0xfB71cbd8CB6f0fb72a9568f11e7E4454309A9cA1
// Swap V2:    0x11395DB7E0AcB7c56fE79FBAFFD48B5BeC896098
// Dice V2:    0x245Fb6ECC6B2beCaf45AC15E4fAc8C78826f0F67

(() => {
  "use strict";

  // ===== Constants =====
  const RPC_URL = "https://rpc.monad.xyz";
  const MONAD_CHAIN_ID_DEC = 143;
  const MONAD_CHAIN_ID_HEX = "0x8f"; // 143 in hex

  const VIN_TOKEN_ADDRESS = "0xfB71cbd8CB6f0fb72a9568f11e7E4454309A9cA1";
  const SWAP_CONTRACT_ADDRESS = "0x11395DB7E0AcB7c56fE79FBAFFD48B5BeC896098";
  const DICE_CONTRACT_ADDRESS = "0x245Fb6ECC6B2beCaf45AC15E4fAc8C78826f0F67";

  const MON_DECIMALS = 18; // native MON uses 18 decimals
  let VIN_DECIMALS = 18;   // will be read from VIN token on init

  // ===== ABIs (minimal) =====

  // VINTokenV2 (ERC20)
  const VIN_ABI = [
    {
      constant: true,
      inputs: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" }
      ],
      name: "allowance",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    {
      constant: false,
      inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" }
      ],
      name: "approve",
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
      type: "function"
    },
    {
      constant: true,
      inputs: [{ name: "account", type: "address" }],
      name: "balanceOf",
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    {
      constant: true,
      inputs: [],
      name: "decimals",
      outputs: [{ name: "", type: "uint8" }],
      stateMutability: "view",
      type: "function"
    },
    {
      constant: false,
      inputs: [
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" }
      ],
      name: "transfer",
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
      type: "function"
    }
  ];

  // Swap MON <-> VIN (1:1)
  const SWAP_ABI = [
    {
      inputs: [],
      name: "getMonReserve",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [],
      name: "getVinReserve",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [],
      name: "swapMonForVin",
      outputs: [],
      stateMutability: "payable",
      type: "function"
    },
    {
      inputs: [{ internalType: "uint256", name: "vinAmount", type: "uint256" }],
      name: "swapVinForMon",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function"
    }
  ];

  // Dice V2
  // Choice: EVEN = 0, ODD = 1
  const DICE_ABI = [
    {
      inputs: [],
      name: "MIN_BET",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [],
      name: "VIN_TOKEN",
      outputs: [{ internalType: "address", name: "", type: "address" }],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [],
      name: "getBankBalance",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [],
      name: "getMaxBet",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    {
      inputs: [
        { internalType: "uint256", name: "amount", type: "uint256" },
        { internalType: "uint8", name: "choice", type: "uint8" },
        { internalType: "uint256", name: "clientSeed", type: "uint256" }
      ],
      name: "play",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function"
    },
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          internalType: "address",
          name: "player",
          type: "address"
        },
        {
          indexed: false,
          internalType: "uint256",
          name: "amount",
          type: "uint256"
        },
        {
          indexed: false,
          internalType: "uint8",
          name: "choice",
          type: "uint8"
        },
        {
          indexed: false,
          internalType: "uint8",
          name: "result",
          type: "uint8"
        },
        {
          indexed: false,
          internalType: "bool",
          name: "won",
          type: "bool"
        }
      ],
      name: "Played",
      type: "event"
    }
  ];

  // ===== Global State =====
  let rpcProvider = null;
  let web3Provider = null;
  let signer = null;
  let currentAccount = null;

  let vinRead = null;
  let vinWrite = null;
  let swapRead = null;
  let swapWrite = null;
  let diceRead = null;
  let diceWrite = null;

  let lastDiceBetBN = null;
  let diceGuessEven = true; // true = EVEN, false = ODD
  let diceMinBetBN = null;
  let diceMaxBetBN = null;
  let diceAllowanceBN = null;
  let lastDiceGame = null;

  let swapDirection = "vinToMon"; // "vinToMon" or "monToVin"

  // ===== Helpers =====
  function $(id) {
    return document.getElementById(id);
  }

  function shortenAddress(addr) {
    if (!addr) return "-";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function formatUnitsSafe(bn, decimals, precision = 4, withGrouping = false) {
    try {
      if (!bn) return "0";
      const str = ethers.utils.formatUnits(bn, decimals);
      const num = Number(str);
      if (!Number.isFinite(num)) return "0";
      if (withGrouping) {
        return num.toLocaleString(undefined, {
          maximumFractionDigits: precision
        });
      } else {
        return num.toFixed(precision);
      }
    } catch {
      return "0";
    }
  }

  function formatVinDisplay(bn, precision = 4) {
    return formatUnitsSafe(bn, VIN_DECIMALS, precision, true);
  }
  function formatVinPlain(bn, precision = 4) {
    return formatUnitsSafe(bn, VIN_DECIMALS, precision, false);
  }
  function formatMonDisplay(bn, precision = 4) {
    return formatUnitsSafe(bn, MON_DECIMALS, precision, true);
  }
  function formatMonPlain(bn, precision = 4) {
    return formatUnitsSafe(bn, MON_DECIMALS, precision, false);
  }

  // Robust parsing for VIN input (accepts both '.' and ',' as decimal separator)
function parseVinInput(str) {
  if (str === null || str === undefined) return null;
  // 1) Trim and convert to string
  let s = String(str).trim();

  // 2) Replace commas with dots (mobile locales often use ',')
  s = s.replace(/,/g, '.');

  // 3) Remove any non-digit/non-dot characters
  s = s.replace(/[^\d.]/g, '');

  // 4) If empty or only dot, return null
  if (!s || s === '.') return null;

  // 5) If multiple dots, keep only the first as decimal separator
  const parts = s.split('.');
  if (parts.length > 1) {
    const intPart = parts.shift();
    const fracPart = parts.join(''); // join remaining parts (removes extra dots)
    s = intPart + '.' + fracPart;
  }

  // 6) Finally parse using ethers with VIN_DECIMALS
  try {
    return ethers.utils.parseUnits(s, VIN_DECIMALS);
  } catch (err) {
    // invalid numeric string for the decimals
    return null;
  }
}


  // Robust parsing for MON input (accepts both '.' and ',' as decimal separator)
function parseMonInput(str) {
  if (str === null || str === undefined) return null;
  let s = String(str).trim();
  // replace comma with dot (mobile locales), remove non-digit/dot
  s = s.replace(/,/g, '.').replace(/[^\d.]/g, '');
  if (!s || s === '.') return null;
  const parts = s.split('.');
  if (parts.length > 1) {
    const intPart = parts.shift();
    const fracPart = parts.join('');
    s = intPart + '.' + fracPart;
  }
  try {
    return ethers.utils.parseUnits(s, MON_DECIMALS);
  } catch (err) {
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

  // ===== Providers & Contracts =====
  function initReadProvider() {
    if (!rpcProvider) {
      rpcProvider = new ethers.providers.JsonRpcProvider(RPC_URL, {
        name: "monad",
        chainId: MONAD_CHAIN_ID_DEC
      });
    }
    if (!vinRead) {
      vinRead = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_ABI, rpcProvider);
    }
    if (!swapRead) {
      swapRead = new ethers.Contract(
        SWAP_CONTRACT_ADDRESS,
        SWAP_ABI,
        rpcProvider
      );
    }
    if (!diceRead) {
      diceRead = new ethers.Contract(
        DICE_CONTRACT_ADDRESS,
        DICE_ABI,
        rpcProvider
      );
    }
  }

  function initWriteContracts() {
    if (!web3Provider || !signer) return;
    vinWrite = new ethers.Contract(VIN_TOKEN_ADDRESS, VIN_ABI, signer);
    swapWrite = new ethers.Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, signer);
    diceWrite = new ethers.Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, signer);
  }

  // ===== Network =====
  async function ensureMonadNetwork() {
    if (!window.ethereum) {
      alert("MetaMask (or a compatible wallet) is required to use this dApp.");
      return false;
    }

    try {
      const chainIdHex = await window.ethereum.request({
        method: "eth_chainId"
      });
      if (chainIdHex === MONAD_CHAIN_ID_HEX) return true;

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: MONAD_CHAIN_ID_HEX }]
      });
      return true;
    } catch (err) {
      console.error("ensureMonadNetwork error:", err);
      alert(
        "Please switch your wallet to the Monad network (chainId 143) before using this dApp."
      );
      return false;
    }
  }

  function setNetworkStatus(connected) {
    const dot = $("networkDot");
    const label = $("networkName");
    const labelHome = $("networkNameHome");

    if (connected) {
      if (dot) {
        dot.classList.remove("dot-disconnected");
        dot.classList.add("dot-connected");
      }
      if (label) label.textContent = "Monad";
      if (labelHome) labelHome.textContent = "Monad";
    } else {
      if (dot) {
        dot.classList.remove("dot-connected");
        dot.classList.add("dot-disconnected");
      }
      if (label) label.textContent = "Not connected";
      if (labelHome) labelHome.textContent = "Not connected";
    }
  }

  // ===== Screens / Navigation =====
  function showScreen(screenId) {
    const screens = ["home-screen", "swap-screen", "dice-screen"];
    screens.forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (id === screenId) el.classList.add("screen-active");
      else el.classList.remove("screen-active");
    });

    const navHome = $("navHome");
    const navSwap = $("navSwap");
    const navDice = $("navDice");

    if (navHome && navSwap && navDice) {
      navHome.classList.remove("active");
      navSwap.classList.remove("active");
      navDice.classList.remove("active");

      if (screenId === "home-screen") navHome.classList.add("active");
      if (screenId === "swap-screen") navSwap.classList.add("active");
      if (screenId === "dice-screen") navDice.classList.add("active");
    }
  }

  function initNav() {
    const navHome = $("navHome");
    const navSwap = $("navSwap");
    const navDice = $("navDice");
    const goToSwap = $("goToSwap");
    const goToDice = $("goToDice");

    if (navHome) navHome.addEventListener("click", () => showScreen("home-screen"));
    if (navSwap) navSwap.addEventListener("click", () => showScreen("swap-screen"));
    if (navDice) navDice.addEventListener("click", () => showScreen("dice-screen"));

    if (goToSwap) goToSwap.addEventListener("click", () => showScreen("swap-screen"));
    if (goToDice) goToDice.addEventListener("click", () => showScreen("dice-screen"));
  }

  // ===== Balances & Pool =====
  async function refreshBalances() {
    try {
      initReadProvider();

      if (!currentAccount) {
        setText("walletAddressShort", "Not connected");
        setText("diceWalletAddressShort", "Not connected");
        setText("vinBalance", "-");
        setText("monBalance", "-");
        setText("diceVinBalance", "-");
        setText("diceMonBalance", "-");
        return;
      }

      const [vinBal, monBal, bankBal] = await Promise.all([
        vinRead.balanceOf(currentAccount),
        rpcProvider.getBalance(currentAccount),
        diceRead.getBankBalance()
      ]);

      const addrShort = shortenAddress(currentAccount);
      setText("walletAddressShort", addrShort);
      setText("diceWalletAddressShort", addrShort);

      const vinStr = formatVinDisplay(vinBal, 4);
      const monStr = formatMonDisplay(monBal, 4);
      const bankStr = formatVinDisplay(bankBal, 4);

      setText("vinBalance", `${vinStr} VIN`);
      setText("monBalance", `${monStr} MON`);

      setText("diceVinBalance", `${vinStr} VIN`);
      setText("diceMonBalance", `${monStr} MON`);

      setText("globalDicePoolVin", `${bankStr} VIN`);
      setText("dicePoolVin", `${bankStr} VIN`);
      setText("dicePoolVinTop", `${bankStr} VIN`);
    } catch (err) {
      console.error("refreshBalances error:", err);
    }
  }

  async function updateDicePool() {
    try {
      initReadProvider();
      const bankBal = await diceRead.getBankBalance();
      const bankStr = formatVinDisplay(bankBal, 4);
      setText("globalDicePoolVin", `${bankStr} VIN`);
      setText("dicePoolVin", `${bankStr} VIN`);
      setText("dicePoolVinTop", `${bankStr} VIN`);
    } catch (err) {
      console.error("updateDicePool error:", err);
    }
  }

  async function updateDiceLimitsAndAllowance() {
  try {
    initReadProvider();

    const [minBet, maxBet] = await Promise.all([
      diceRead.MIN_BET(),
      diceRead.getMaxBet()
    ]);

    // Store min/max bet to use in other calculations
    // Do NOT update or display anything related to diceMinInfo anymore
    diceMinBetBN = minBet;
    diceMaxBetBN = maxBet;

    if (currentAccount) {
      const allowance = await vinRead.allowance(
        currentAccount,
        DICE_CONTRACT_ADDRESS
      );
      diceAllowanceBN = allowance;
      const allowanceStr = formatVinDisplay(allowance, 4);
      setText("diceAllowance", `${allowanceStr} VIN`);
    }
  } catch (err) {
    console.error("updateDiceLimitsAndAllowance error:", err);
    // No update to diceMinInfo here either
  }
}

  // ===== Swap Logic =====
  function updateSwapDirectionUI() {
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    const fromToken = $("swapFromToken");
    const toToken = $("swapToToken");
    const rateLabel = $("swapRateLabel");

    if (tabVinToMon && tabMonToVin) {
      tabVinToMon.classList.remove("active");
      tabMonToVin.classList.remove("active");
      if (swapDirection === "vinToMon") {
        tabVinToMon.classList.add("active");
      } else {
        tabMonToVin.classList.add("active");
      }
    }

    if (fromToken && toToken) {
      if (swapDirection === "vinToMon") {
        fromToken.textContent = "VIN";
        toToken.textContent = "MON";
      } else {
        fromToken.textContent = "MON";
        toToken.textContent = "VIN";
      }
    }

    if (rateLabel) {
      rateLabel.textContent = "Rate: 1 VIN = 1 MON (no fee)";
    }
  }

  async function refreshSwapBalancesLabels() {
    try {
      initReadProvider();
      const fromLabel = $("fromBalanceLabel");
      const toLabel = $("toBalanceLabel");
      if (!currentAccount || !fromLabel || !toLabel) return;

      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(currentAccount),
        rpcProvider.getBalance(currentAccount)
      ]);

      const vinStr = formatVinDisplay(vinBal, 4);
      const monStr = formatMonDisplay(monBal, 4);

      if (swapDirection === "vinToMon") {
        fromLabel.textContent = `Balance: ${vinStr} VIN`;
        toLabel.textContent = `Balance: ${monStr} MON`;
      } else {
        fromLabel.textContent = `Balance: ${monStr} MON`;
        toLabel.textContent = `Balance: ${vinStr} VIN`;
      }
    } catch (err) {
      console.error("refreshSwapBalancesLabels error:", err);
    }
  }

  function getSwapInputElements() {
    const fromAmountEl = $("swapFromAmount");
    const toAmountEl = $("swapToAmount");
    const statusEl = $("swapStatus");
    return { fromAmountEl, toAmountEl, statusEl };
  }

  function recalcSwapOutput() {
    const { fromAmountEl, toAmountEl, statusEl } = getSwapInputElements();
    if (!fromAmountEl || !toAmountEl) return;

    const raw = fromAmountEl.value.trim();
    if (!raw) {
      toAmountEl.value = "";
      if (statusEl) statusEl.textContent = "";
      return;
    }

    let fromBn;
    if (swapDirection === "vinToMon") {
      fromBn = parseVinInput(raw);
    } else {
      fromBn = parseMonInput(raw);
    }

    if (!fromBn || fromBn.lte(0)) {
      toAmountEl.value = "";
      if (statusEl) statusEl.textContent = "Invalid amount.";
      return;
    }

    const toBn = fromBn; // 1:1
    if (swapDirection === "vinToMon") {
      toAmountEl.value = formatMonPlain(toBn, 6);
    } else {
      toAmountEl.value = formatVinPlain(toBn, 6);
    }
    if (statusEl) statusEl.textContent = "Ready to swap.";
  }

  async function handleSwapMax() {
    try {
      if (!currentAccount) {
        alert("Please connect your wallet first.");
        return;
      }
      initReadProvider();
      const { fromAmountEl } = getSwapInputElements();
      if (!fromAmountEl) return;

      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(currentAccount),
        rpcProvider.getBalance(currentAccount)
      ]);

      if (swapDirection === "vinToMon") {
        fromAmountEl.value = formatVinPlain(vinBal, 6);
      } else {
        fromAmountEl.value = formatMonPlain(monBal, 6);
      }
      recalcSwapOutput();
    } catch (err) {
      console.error("handleSwapMax error:", err);
    }
  }

  async function handleSwapAction() {
    const { fromAmountEl, statusEl } = getSwapInputElements();
    if (!fromAmountEl || !statusEl) return;

    if (!currentAccount || !web3Provider || !signer) {
      alert("Please connect your wallet first.");
      return;
    }

    if (!(await ensureMonadNetwork())) return;

    initReadProvider();
    initWriteContracts();

    const raw = fromAmountEl.value.trim();
    if (!raw) {
      statusEl.textContent = "Please enter an amount.";
      return;
    }

    try {
      const [vinBal, monBal] = await Promise.all([
        vinRead.balanceOf(currentAccount),
        rpcProvider.getBalance(currentAccount)
      ]);

      if (swapDirection === "vinToMon") {
        const amountBN = parseVinInput(raw);
        if (!amountBN || amountBN.lte(0)) {
          statusEl.textContent = "Invalid VIN amount.";
          return;
        }
        if (vinBal.lt(amountBN)) {
          statusEl.textContent = "Insufficient VIN balance.";
          return;
        }

        // Check allowance
        const allowance = await vinRead.allowance(
          currentAccount,
          SWAP_CONTRACT_ADDRESS
        );
        if (allowance.lt(amountBN)) {
          statusEl.textContent = "Approving VIN for the swap contract...";
          const approveTx = await vinWrite.approve(
            SWAP_CONTRACT_ADDRESS,
            ethers.constants.MaxUint256
          );
          await approveTx.wait();
        }

        statusEl.textContent = "Sending VIN→MON swap transaction...";
        const gasEstimate = await swapWrite.estimateGas.swapVinForMon(amountBN);
        const gasLimit = gasEstimate.mul(120).div(100);

        const tx = await swapWrite.swapVinForMon(amountBN, { gasLimit });
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
          statusEl.textContent = "Swap transaction reverted.";
          return;
        }
        statusEl.textContent = "Swap VIN→MON successful!";
      } else {
        const amountBN = parseMonInput(raw);
        if (!amountBN || amountBN.lte(0)) {
          statusEl.textContent = "Invalid MON amount.";
          return;
        }
        if (monBal.lt(amountBN)) {
          statusEl.textContent = "Insufficient MON balance.";
          return;
        }

        statusEl.textContent = "Sending MON→VIN swap transaction...";
        const gasEstimate = await swapWrite.estimateGas.swapMonForVin({
          value: amountBN
        });
        const gasLimit = gasEstimate.mul(120).div(100);

        const tx = await swapWrite.swapMonForVin({
          value: amountBN,
          gasLimit
        });
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
          statusEl.textContent = "Swap transaction reverted.";
          return;
        }
        statusEl.textContent = "Swap MON→VIN successful!";
      }

      await Promise.all([
        refreshBalances(),
        refreshSwapBalancesLabels(),
        updateDicePool()
      ]);
      recalcSwapOutput();
    } catch (err) {
      console.error("handleSwapAction error:", err);
      const reason = extractRevertReason(err);
      statusEl.textContent =
        "Swap failed on-chain. " + (reason ? `Reason: ${reason}` : "");
      alert(
        "Swap transaction failed on-chain.\n" +
          (reason ? `Reason: ${reason}` : "")
      );
    }
  }

  function initSwapEvents() {
    const tabVinToMon = $("tabVinToMon");
    const tabMonToVin = $("tabMonToVin");
    const fromAmountEl = $("swapFromAmount");
    const maxBtn = $("swapMaxButton");
    const actionBtn = $("swapActionButton");

    if (tabVinToMon) {
      tabVinToMon.addEventListener("click", () => {
        swapDirection = "vinToMon";
        updateSwapDirectionUI();
        refreshSwapBalancesLabels();
        recalcSwapOutput();
      });
    }

    if (tabMonToVin) {
      tabMonToVin.addEventListener("click", () => {
        swapDirection = "monToVin";
        updateSwapDirectionUI();
        refreshSwapBalancesLabels();
        recalcSwapOutput();
      });
    }

    if (fromAmountEl) {
      fromAmountEl.addEventListener("input", recalcSwapOutput);
    }
    if (maxBtn) {
      maxBtn.addEventListener("click", handleSwapMax);
    }
    if (actionBtn) {
      actionBtn.addEventListener("click", handleSwapAction);
    }

    updateSwapDirectionUI();
  }

  // ===== Dice Logic =====
  function getCurrentDiceChoice() {
    return diceGuessEven ? 0 : 1; // 0 = EVEN, 1 = ODD
  }

  function onGuessButtonClick(isEven) {
    diceGuessEven = isEven;
    const evenBtn = $("guessEvenButton");
    const oddBtn = $("guessOddButton");
    if (evenBtn && oddBtn) {
      if (isEven) {
        evenBtn.classList.add("active");
        oddBtn.classList.remove("active");
      } else {
        oddBtn.classList.add("active");
        evenBtn.classList.remove("active");
      }
    }
  }

  // Visual for 4 coins: random patterns for even/odd
  function setDiceVisual(resultEven) {
    const visual = $("diceVisual");
    if (!visual) return;

    // Remove previous even/odd classes (if used for styling)
    visual.classList.remove("dice-even", "dice-odd");

    const coins = visual.querySelectorAll(".dice-coin");
    if (!coins || coins.length !== 4) {
      return;
    }

    if (resultEven === null || resultEven === undefined) {
      return;
    }

    // Helper to shuffle an array
    function shuffleArray(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
      }
      return a;
    }

    let patternBits; // 0 = white, 1 = red

    if (resultEven) {
      // EVEN patterns: (1) 4 white, (2) 4 red, (3) 2 red + 2 white (random positions)
      const t = Math.floor(Math.random() * 3);
      if (t === 0) {
        patternBits = [0, 0, 0, 0]; // 4 white
      } else if (t === 1) {
        patternBits = [1, 1, 1, 1]; // 4 red
      } else {
        patternBits = shuffleArray([1, 1, 0, 0]); // 2 red, 2 white
      }
      visual.classList.add("dice-even");
    } else {
      // ODD patterns: (1) 1 red + 3 white, (2) 3 red + 1 white (random positions)
      const t = Math.floor(Math.random() * 2);
      if (t === 0) {
        patternBits = shuffleArray([1, 0, 0, 0]);
      } else {
        patternBits = shuffleArray([1, 1, 1, 0]);
      }
      visual.classList.add("dice-odd");
    }

    coins.forEach((coin, idx) => {
      coin.classList.remove("dice-coin-red", "dice-coin-white");
      if (patternBits[idx] === 1) {
        coin.classList.add("dice-coin-red");
      } else {
        coin.classList.add("dice-coin-white");
      }
    });
  }

  function updateDiceLastResultUI() {
    const resEl = $("diceLastResult");
    const outcomeEl = $("diceLastOutcome");
    const winLossEl = $("diceLastWinLoss");
    const payoutEl = $("diceLastPayout");
    const txEl = $("diceLastTx");

    if (!lastDiceGame) {
      if (resEl) resEl.textContent = "-";
      if (outcomeEl) outcomeEl.textContent = "-";
      if (winLossEl) winLossEl.textContent = "-";
      if (payoutEl) payoutEl.textContent = "-";
      if (txEl) txEl.textContent = "-";
      setDiceVisual(null);
      return;
    }

    const { amountVin, choiceEven, resultEven, won, payoutVin, txHash } =
      lastDiceGame;

    const betStr = choiceEven ? "Even" : "Odd";
    const outcomeStr = resultEven ? "Even" : "Odd";

    if (resEl)
      resEl.textContent = `Last roll - Bet: ${betStr}, Amount: ${amountVin}`;
    if (outcomeEl) outcomeEl.textContent = `Outcome: ${outcomeStr}`;
    if (winLossEl) winLossEl.textContent = won ? "You: WON" : "You: lost";
    if (payoutEl) payoutEl.textContent = `Payout: ${payoutVin}`;
    if (txEl) {
      const shortTx = txHash
        ? txHash.slice(0, 10) + "..." + txHash.slice(-6)
        : "-";
      txEl.textContent = shortTx;
    }

    setDiceVisual(resultEven);
  }

  async function handleDiceApprove() {
    try {
      if (!currentAccount || !web3Provider || !signer) {
        alert("Please connect your wallet first.");
        return;
      }
      if (!(await ensureMonadNetwork())) return;

      initWriteContracts();

      const statusEl = $("diceStatus");
      if (statusEl) statusEl.textContent = "Sending approve transaction...";

      // Approve 100,000,000 VIN by default so user can play long-term
      const maxAmount = ethers.utils.parseUnits("100000000", VIN_DECIMALS); // 100,000,000 VIN
      const tx = await vinWrite.approve(DICE_CONTRACT_ADDRESS, maxAmount);
      const receipt = await tx.wait();
      if (receipt.status !== 1) {
        if (statusEl) statusEl.textContent = "Approve transaction reverted.";
        return;
      }

      if (statusEl) statusEl.textContent = "Approve successful.";
      await updateDiceLimitsAndAllowance();
      await refreshBalances();
    } catch (err) {
      console.error("handleDiceApprove error:", err);
      const statusEl = $("diceStatus");
      const reason = extractRevertReason(err);
      if (statusEl)
        statusEl.textContent =
          "Approve failed on-chain. " +
          (reason ? `Reason: ${reason}` : "");
      alert(
        "Approve transaction failed on-chain.\n" +
          (reason ? `Reason: ${reason}` : "")
      );
    }
  }

  function getDiceBetAmountBN() {
    const input = $("diceBetAmount");
    if (!input) return null;
    const raw = input.value.trim();
    if (!raw) return null;
    return parseVinInput(raw);
  }

  function setDiceBetAmountFromBN(bn) {
    const input = $("diceBetAmount");
    if (!input || !bn) return;
    input.value = formatVinPlain(bn, 6);
  }

  async function handleDicePlay() {
    const statusEl = $("diceStatus");
    if (!statusEl) return;
    const visual = $("diceVisual");

    try {
      if (!currentAccount || !web3Provider || !signer) {
        alert("Please connect your wallet first.");
        return;
      }
      if (!(await ensureMonadNetwork())) return;

      initReadProvider();
      initWriteContracts();

      const amountBN = getDiceBetAmountBN();
      if (!amountBN || amountBN.lte(0)) {
        statusEl.textContent = "Invalid bet amount.";
        return;
      }

      if (diceMinBetBN && amountBN.lt(diceMinBetBN)) {
        const minStr = formatVinDisplay(diceMinBetBN);
        statusEl.textContent = `Bet is below minimum: ${minStr} VIN.`;
        alert(`Bet is below minimum: ${minStr} VIN.`);
        return;
      }

      if (diceMaxBetBN && amountBN.gt(diceMaxBetBN)) {
        const maxStr = formatVinDisplay(diceMaxBetBN);
        statusEl.textContent = `Bet is above recommended maximum: ${maxStr} VIN.`;
        if (
          !window.confirm(
            `This bet is higher than the recommended maximum (${maxStr} VIN). Continue anyway?`
          )
        ) {
          return;
        }
      }

      const vinBal = await vinRead.balanceOf(currentAccount);
      if (vinBal.lt(amountBN)) {
        statusEl.textContent = "Insufficient VIN balance.";
        alert("Insufficient VIN balance.");
        return;
      }

      const allowance = await vinRead.allowance(
        currentAccount,
        DICE_CONTRACT_ADDRESS
      );
      diceAllowanceBN = allowance;
      if (allowance.lt(amountBN)) {
        const needStr = formatVinDisplay(amountBN);
        const allowStr = formatVinDisplay(allowance);
        statusEl.textContent = "Dice allowance is too low.";
        alert(
          `Dice allowance is too low (${allowStr} VIN).\n` +
            `Required allowance: at least ${needStr} VIN.\n` +
            `Please click "Approve VIN for Dice" first.`
        );
        return;
      }

      // Start shaking visual while waiting for on-chain result
      if (visual) {
        visual.classList.add("dice-shaking");
      }

      lastDiceBetBN = amountBN;
      const choice = getCurrentDiceChoice();
      const clientSeed = getRandomClientSeed();

      let gasLimit;
      try {
        const gasEstimate = await diceWrite.estimateGas.play(
          amountBN,
          choice,
          clientSeed
        );
        gasLimit = gasEstimate.mul(120).div(100);
      } catch (err) {
        console.error("Dice estimateGas reverted:", err);
        const reason = extractRevertReason(err);
        statusEl.textContent =
          "This bet would revert on-chain. " + (reason || "");
        alert(
          "Dice transaction would revert on-chain.\n" +
            (reason ? `Reason: ${reason}` : "")
        );
        return;
      }

      statusEl.textContent = "Sending Dice transaction...";
      const tx = await diceWrite.play(amountBN, choice, clientSeed, {
        gasLimit
      });
      const receipt = await tx.wait();
      if (receipt.status !== 1) {
        statusEl.textContent = "Dice transaction reverted.";
        return;
      }

      // Decode Played event
      const iface = new ethers.utils.Interface(DICE_ABI);
      let parsedEvent = null;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed.name === "Played") {
            parsedEvent = parsed;
            break;
          }
        } catch {
          // ignore non-matching logs
        }
      }

      if (parsedEvent) {
        const { player, amount, choice, result, won } = parsedEvent.args;
        const amountStr = formatVinDisplay(amount, 4);
        const payoutBN = amount.mul(2);
        const payoutStr = won
          ? `${formatVinDisplay(payoutBN, 4)} VIN`
          : "0 VIN";

        lastDiceGame = {
          player,
          amountVin: `${amountStr} VIN`,
          choiceEven: choice === 0,
          resultEven: result === 0,
          won,
          payoutVin: payoutStr,
          txHash: receipt.transactionHash
        };

        statusEl.textContent = won
          ? `You WON! Payout: ${payoutStr}`
          : "You lost this round.";
        updateDiceLastResultUI();
      } else {
        statusEl.textContent =
          "Dice transaction confirmed, but event not found.";
      }

      await Promise.all([refreshBalances(), updateDicePool()]);
    } catch (err) {
      console.error("handleDicePlay error:", err);
      const statusEl = $("diceStatus");
      const reason = extractRevertReason(err);
      if (statusEl)
        statusEl.textContent =
          "Dice transaction failed on-chain. " +
          (reason ? `Reason: ${reason}` : "");
      alert(
        "Dice transaction failed on-chain.\n" +
          (reason ? `Reason: ${reason}` : "")
      );
    } finally {
      // Always stop shaking once we have a result or an error
      if (visual) {
        visual.classList.remove("dice-shaking");
      }
    }
  }

  function initDiceEvents() {
    const evenBtn = $("guessEvenButton");
    const oddBtn = $("guessOddButton");
    const approveBtn = $("diceApproveButton");
    const playBtn = $("dicePlayButton");
    const maxBtn = $("diceMaxButton");
    const repeatBtn = $("diceRepeatButton");
    const halfBtn = $("diceHalfButton");
    const doubleBtn = $("diceDoubleButton");
    const clearBtn = $("diceClearButton");
    const refreshLastBtn = $("diceRefreshLast");

    if (evenBtn)
      evenBtn.addEventListener("click", () => onGuessButtonClick(true));
    if (oddBtn)
      oddBtn.addEventListener("click", () => onGuessButtonClick(false));

    if (approveBtn)
      approveBtn.addEventListener("click", () => {
        handleDiceApprove();
      });

    if (playBtn)
      playBtn.addEventListener("click", () => {
        handleDicePlay();
      });

    if (maxBtn) {
      maxBtn.addEventListener("click", async () => {
        try {
          if (!currentAccount) {
            alert("Please connect your wallet first.");
            return;
          }
          initReadProvider();
          const vinBal = await vinRead.balanceOf(currentAccount);
          setDiceBetAmountFromBN(vinBal);
        } catch (err) {
          console.error("diceMaxButton error:", err);
        }
      });
    }

    if (repeatBtn) {
      repeatBtn.addEventListener("click", () => {
        if (lastDiceBetBN) setDiceBetAmountFromBN(lastDiceBetBN);
      });
    }

    if (halfBtn) {
      halfBtn.addEventListener("click", () => {
        const bn = getDiceBetAmountBN();
        if (!bn) return;
        const half = bn.div(2);
        if (half.gt(0)) setDiceBetAmountFromBN(half);
      });
    }

    if (doubleBtn) {
      doubleBtn.addEventListener("click", () => {
        const bn = getDiceBetAmountBN();
        if (!bn) return;
        const doubled = bn.mul(2);
        setDiceBetAmountFromBN(doubled);
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const input = $("diceBetAmount");
        if (input) input.value = "";
      });
    }

    if (refreshLastBtn) {
      refreshLastBtn.addEventListener("click", () => {
        updateDiceLastResultUI();
        updateDicePool();
      });
    }

    // Default guess = EVEN
    onGuessButtonClick(true);
  }

  // ===== Wallet =====
  async function connectWallet() {
    try {
      if (!window.ethereum) {
        alert("MetaMask (or a compatible wallet) is required to use this dApp.");
        return;
      }

      const ok = await ensureMonadNetwork();
      if (!ok) return;

      web3Provider = new ethers.providers.Web3Provider(window.ethereum);
      const accounts = await web3Provider.send("eth_requestAccounts", []);
      if (!accounts || accounts.length === 0) {
        alert("No accounts found in wallet.");
        return;
      }
      currentAccount = ethers.utils.getAddress(accounts[0]);
      signer = web3Provider.getSigner();
      initWriteContracts();

      const connectBtn = $("connectButton");
      if (connectBtn) {
        connectBtn.textContent = shortenAddress(currentAccount);
        connectBtn.classList.add("btn-connected");
      }

      setNetworkStatus(true);
      await Promise.all([
        (async () => {
          try {
            initReadProvider();
            const dec = await vinRead.decimals();
            VIN_DECIMALS = Number(dec);
          } catch (e) {
            console.error("Failed to read VIN decimals, defaulting to 18.", e);
            VIN_DECIMALS = 18;
          }
        })(),
        refreshBalances(),
        refreshSwapBalancesLabels(),
        updateDicePool(),
        updateDiceLimitsAndAllowance()
      ]);
      updateDiceLastResultUI();
    } catch (err) {
      console.error("connectWallet error:", err);
      alert("Failed to connect wallet. Please try again.");
    }
  }

  function initWalletEvents() {
    const connectBtn = $("connectButton");
    const refreshBtn = $("refreshBalances");

    if (connectBtn) {
      connectBtn.addEventListener("click", connectWallet);
    }
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        await refreshBalances();
        await updateDicePool();
      });
    }

    if (window.ethereum) {
      window.ethereum.on("accountsChanged", (accounts) => {
        if (!accounts || accounts.length === 0) {
          currentAccount = null;
          signer = null;
          web3Provider = null;
          setText("walletAddressShort", "Not connected");
          setText("diceWalletAddressShort", "Not connected");
          setNetworkStatus(false);
          const connectBtnInner = $("connectButton");
          if (connectBtnInner) {
            connectBtnInner.textContent = "Connect Wallet";
            connectBtnInner.classList.remove("btn-connected");
          }
        } else {
          currentAccount = ethers.utils.getAddress(accounts[0]);
          if (web3Provider) {
            signer = web3Provider.getSigner();
            initWriteContracts();
          }
          setText("walletAddressShort", shortenAddress(currentAccount));
          setText("diceWalletAddressShort", shortenAddress(currentAccount));
          setNetworkStatus(true);
          refreshBalances();
          refreshSwapBalancesLabels();
          updateDicePool();
          updateDiceLimitsAndAllowance();
        }
      });

      window.ethereum.on("chainChanged", (chainId) => {
        if (chainId !== MONAD_CHAIN_ID_HEX) {
          setNetworkStatus(false);
        } else {
          setNetworkStatus(true);
          refreshBalances();
          refreshSwapBalancesLabels();
          updateDicePool();
          updateDiceLimitsAndAllowance();
        }
      });
    }
  }

  // ===== Init =====
  async function initApp() {
    try {
      initReadProvider();
      setNetworkStatus(false);

      initNav();
      initSwapEvents();
      initDiceEvents();
      initWalletEvents();

      await updateDicePool();
      updateDiceLastResultUI();
    } catch (err) {
      console.error("initApp error:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
