// app.js - VINMonad dApp
// Uses ethers.js v5.7.2 (loaded from CDN in index.html)

/* ============================================================
   GLOBAL CONSTANTS & STATE
============================================================ */

const RPC_URL = "https://rpc.monad.xyz";
const MONAD_CHAIN_ID_DEC = 143;
const MONAD_CHAIN_ID_HEX = "0x8f"; // 143 in hex

const VIN_TOKEN_ADDRESS = "0x038A2f1abe221d403834aa775669169Ef5eb120A";
const SWAP_CONTRACT_ADDRESS = "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB";
const DICE_CONTRACT_ADDRESS = "0xB8D7D799eE31FedD38e63801419782E8110326E4";
const LOTTO_CONTRACT_ADDRESS = "0x85993C463f2b4a8656871891b463AeA79734ab27";

const MON_DECIMALS = 18;
let VIN_DECIMALS = 18;

const SWAP_RATE = 100; // 1 VIN = 100 MON
const DICE_APPROVE_AMOUNT = "100000000"; // 100M VIN allowance for Dice
const LOTTO_APPROVE_AMOUNT = "100000000"; // 100M VIN allowance for Lotto

// Ethers / provider / signer
let ethProvider = null;
let signer = null;
let userAddress = null;

// Contracts (read & write)
let vinRead = null;
let vinWrite = null;
let swapRead = null;
let swapWrite = null;
let diceRead = null;
let diceWrite = null;
let lottoRead = null;
let lottoWrite = null;

// UI state
let activeScreen = "home"; // "home" | "swap" | "dice" | "lotto"
let activeSwapDirection = "VIN_TO_MON"; // or "MON_TO_VIN"
let lastDiceBet = {
  amount: null,
  choice: "even"
};
let lastLottoBets = [];

// Lotto row counter (for unique radio names)
let lottoRowCounter = 1;

 // ===== ABIs (minimal) =====

  // VIN (ERC20)
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

const SWAP_ABI = [
  "function RATE() view returns (uint256)",
  "function swapVINtoMON(uint256 vinAmount)",
  "function swapMONtoVIN() payable"
];
  
  const DICE_ABI = [
  "function MIN_BET() view returns (uint256)",
  "function MAX_BET() view returns (uint256)",
  "function bankBalance() view returns (uint256)",
  "function maxBetAllowed() view returns (uint256)",
  "function play(uint256 amount, uint8 choice, uint256 clientSeed)",
  "event Played(address indexed player,uint256 amount,uint8 choice,uint8 result,bool won)"
];
  
const LOTTO_ABI = [
  // ===== Views =====
  "function MIN_BET() view returns (uint256)",
  "function RESULTS_COUNT() view returns (uint8)",
  "function nonce() view returns (uint256)",
  "function VIN() view returns (address)",

  // ===== Safety check (optional, but useful for UI precheck) =====
  "function maxPossiblePayout((uint8 number,uint256 amount,uint8 betType)[] bets) pure returns (uint256)",

  // ===== Core play =====
  "function play((uint8 number,uint256 amount,uint8 betType)[] bets)",

  // ===== Event (CRITICAL for decoding results) =====
  "event Played(address indexed player,(uint8 number,uint256 amount,uint8 betType)[] bets,uint8[27] results,uint256 totalBet,uint256 totalPayout)"
];

/* ============================================================
   DOM HELPERS
============================================================ */

function $(id) {
  return document.getElementById(id);
}

function shortenAddress(addr) {
  if (!addr) return "-";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function formatUnitsRaw(bn, decimals) {
  try {
    return window.ethers.utils.formatUnits(bn, decimals);
  } catch {
    return "0";
  }
}

// Pretty number formatting for UI (comma thousands, dot decimals, limited decimals)
function formatTokenPretty(bn, decimals, maxDecimals = 4) {
  try {
    const raw = window.ethers.utils.formatUnits(bn || 0, decimals);
    return formatNumberPretty(raw, maxDecimals);
  } catch {
    return "0";
  }
}

function formatNumberPretty(value, maxDecimals = 4) {
  // value can be string/number like "12345.678901"
  const s = String(value ?? "0").trim();
  if (!s || s === "-" || s === "NaN") return "0";
  const n = Number(s);
  if (!Number.isFinite(n)) return "0";

  // Use en-US formatting: 1,234.56
  // Keep up to maxDecimals, but avoid trailing zeros.
  const nf = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, maxDecimals)
  });
  return nf.format(n);
}

function parseUnitsSafe(value, decimals) {
  const { utils } = window.ethers;
  let v = String(value || "").trim();
  if (!v) return null;
  // Replace comma with dot
  v = v.replace(/,/g, ".");
  // Remove invalid chars
  v = v.replace(/[^\d.]/g, "");
  if (!v) return null;
  try {
    return utils.parseUnits(v, decimals);
  } catch {
    return null;
  }
}

function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}

function setStatus(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/* ============================================================
   NETWORK / WALLET HANDLING
============================================================ */

async function connectWallet() {
  const connectBtn = $("connectButton");
  try {
    const eth = window.ethereum;
    if (!eth) {
      alert("No Ethereum-compatible wallet detected. Please install MetaMask or similar.");
      return;
    }

    if (connectBtn) connectBtn.textContent = "Connecting...";

    // Request accounts (wallet popup)
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) {
      if (connectBtn) connectBtn.textContent = "Connect Wallet";
      return;
    }

    userAddress = window.ethers.utils.getAddress(accounts[0]);

    // Setup provider & signer (wallet)
    ethProvider = new window.ethers.providers.Web3Provider(eth, "any");
    signer = ethProvider.getSigner();

    // Check/switch network quickly
    const chainIdHex = await eth.request({ method: "eth_chainId" });
    const chainDec = parseInt(chainIdHex, 16);

    if (chainDec !== MONAD_CHAIN_ID_DEC) {
      updateNetworkIndicatorWrong();
      await switchToMonadNetwork();
      // After switching, re-check
      const chainIdHex2 = await eth.request({ method: "eth_chainId" });
      const chainDec2 = parseInt(chainIdHex2, 16);
      if (chainDec2 === MONAD_CHAIN_ID_DEC) {
        updateNetworkIndicatorConnected();
      } else {
        updateNetworkIndicatorWrong();
      }
    } else {
      updateNetworkIndicatorConnected();
    }

    // Initialize contracts
    initContracts();

    // Load VIN decimals
    await syncVinDecimals();

    // Update UI & balances
    updateWalletUI();
    await refreshAllBalancesAndPools();
  } catch (err) {
    console.error("connectWallet error:", err);
    alert("Failed to connect wallet.");
  } finally {
    updateWalletUI();
  }
}

async function switchToMonadNetwork() {
  const eth = window.ethereum;
  if (!eth) return;

  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: MONAD_CHAIN_ID_HEX }]
    });
  } catch (switchError) {
    // If chain is not added to MetaMask
    if (switchError.code === 4902 || switchError.code === -32603) {
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: MONAD_CHAIN_ID_HEX,
              chainName: "Monad",
              nativeCurrency: {
                name: "MON",
                symbol: "MON",
                decimals: 18
              },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: ["https://monadvision.com"]
            }
          ]
        });
      } catch (addError) {
        console.error("Failed to add Monad network:", addError);
        throw addError;
      }
    } else {
      console.error("Failed to switch network:", switchError);
      throw switchError;
    }
  }
}

function initContracts() {
  if (!ethProvider || !signer) return;

  const { Contract } = window.ethers;

  vinRead = new Contract(VIN_TOKEN_ADDRESS, VIN_ABI, ethProvider);
  vinWrite = vinRead.connect(signer);

  swapRead = new Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, ethProvider);
  swapWrite = swapRead.connect(signer);

  diceRead = new Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, ethProvider);
  diceWrite = diceRead.connect(signer);

  lottoRead = new Contract(LOTTO_CONTRACT_ADDRESS, LOTTO_ABI, ethProvider);
  lottoWrite = lottoRead.connect(signer);
}
function initReadContracts() {
  // Read-only contracts used before wallet connects
  try {
    const { Contract } = window.ethers;
    const p = ethProvider || new window.ethers.providers.JsonRpcProvider(RPC_URL);
    vinRead = new Contract(VIN_TOKEN_ADDRESS, VIN_ABI, p);
    swapRead = new Contract(SWAP_CONTRACT_ADDRESS, SWAP_ABI, p);
    diceRead = new Contract(DICE_CONTRACT_ADDRESS, DICE_ABI, p);
    lottoRead = new Contract(LOTTO_CONTRACT_ADDRESS, LOTTO_ABI, p);
  } catch (e) {
    console.error("initReadContracts error:", e);
  }
}

async function syncVinDecimalsRead() {
  try {
    if (!vinRead) return;
    const dec = await vinRead.decimals();
    VIN_DECIMALS = dec;
  } catch {
    VIN_DECIMALS = 18;
  }
}


async function syncVinDecimals() {
  try {
    if (!vinRead) return;
    const dec = await vinRead.decimals();
    VIN_DECIMALS = dec;
  } catch (err) {
    console.warn("Could not read VIN decimals, using 18:", err);
    VIN_DECIMALS = 18;
  }
}

function setupWalletEventListeners() {
  const eth = window.ethereum;
  if (!eth) return;

  eth.removeAllListeners?.("accountsChanged");
  eth.removeAllListeners?.("chainChanged");

  eth.on("accountsChanged", async (accounts) => {
    if (!accounts || !accounts.length) {
      userAddress = null;
      signer = null;
      updateNetworkIndicatorDisconnected();
      updateWalletUI();
      return;
    }
    userAddress = window.ethers.utils.getAddress(accounts[0]);
    ethProvider = new window.ethers.providers.Web3Provider(eth);
    signer = ethProvider.getSigner();
    initContracts();
    try {
      const chainIdHex = await eth.request({ method: "eth_chainId" });
      const chainDec = parseInt(chainIdHex, 16);
      if (chainDec === MONAD_CHAIN_ID_DEC) updateNetworkIndicatorConnected();
      else updateNetworkIndicatorWrong();
    } catch (_) {}

    await syncVinDecimals();
    await refreshAllBalancesAndPools();
    updateWalletUI();
  });

  eth.on("chainChanged", async (chainId) => {
    const chainDec = parseInt(chainId, 16);
    if (chainDec !== MONAD_CHAIN_ID_DEC) {
      updateNetworkIndicatorWrong();
    } else {
      updateNetworkIndicatorConnected();
    }
    if (userAddress && ethProvider) {
      ethProvider = new window.ethers.providers.Web3Provider(eth);
      signer = ethProvider.getSigner();
      initContracts();
      await syncVinDecimals();
      await refreshAllBalancesAndPools();
      updateWalletUI();
    }
  });
}

/* ============================================================
   NETWORK INDICATOR & WALLET UI
============================================================ */

function updateNetworkIndicatorConnected() {
  const dot = $("networkDot");
  const label = $("networkName");
  const labelHome = $("networkNameHome");

  if (dot) {
    dot.classList.remove("dot-disconnected");
    dot.classList.add("dot-connected");
  }
  if (label) label.textContent = "Monad";
  if (labelHome) labelHome.textContent = "Monad";
}

function updateNetworkIndicatorDisconnected() {
  const dot = $("networkDot");
  const label = $("networkName");
  const labelHome = $("networkNameHome");

  if (dot) {
    dot.classList.remove("dot-connected");
    dot.classList.add("dot-disconnected");
  }
  if (label) label.textContent = "Not connected";
  if (labelHome) labelHome.textContent = "Not connected";
}

function updateNetworkIndicatorWrong() {
  const dot = $("networkDot");
  const label = $("networkName");
  const labelHome = $("networkNameHome");

  if (dot) {
    dot.classList.remove("dot-connected");
    dot.classList.add("dot-disconnected");
  }
  if (label) label.textContent = "Wrong network";
  if (labelHome) labelHome.textContent = "Wrong network";
}

function updateWalletUI() {
  const short = userAddress ? shortenAddress(userAddress) : "Not connected";

  setText($("walletAddressShort"), short);
  setText($("diceWalletAddressShort"), short);
  setText($("lottoWalletAddressShort"), short);

  const connectBtn = $("connectButton");
  if (connectBtn) {
    connectBtn.textContent = userAddress ? "Connected" : "Connect Wallet";
  }

  // If we have a wallet + provider, refresh network indicator quickly
  try {
    const eth = window.ethereum;
    if (userAddress && eth && eth.request) {
      eth.request({ method: "eth_chainId" }).then((hex) => {
        const dec = parseInt(hex, 16);
        if (dec === MONAD_CHAIN_ID_DEC) updateNetworkIndicatorConnected();
        else updateNetworkIndicatorWrong();
      }).catch(() => {});
    } else if (!userAddress) {
      // keep disconnected label as-is
    }
  } catch (_) {}
}

/* ============================================================
   BALANCES & POOL INFO
============================================================ */

async function refreshAllBalancesAndPools() {
  try {
    if (!ethProvider) {
      ethProvider = new window.ethers.providers.JsonRpcProvider(RPC_URL);
    }
    const provider = ethProvider;
    const hasUser = !!userAddress;

    // Native MON balance
    let monBalanceBN = window.ethers.BigNumber.from(0);
    if (hasUser) {
      monBalanceBN = await provider.getBalance(userAddress);
    }

    // VIN balance
    let vinBalanceBN = window.ethers.BigNumber.from(0);
    if (hasUser && vinRead) {
      vinBalanceBN = await vinRead.balanceOf(userAddress);
    }

    // Global Dice pool (VIN)
    let dicePoolBN = window.ethers.BigNumber.from(0);
    if (diceRead) {
      try {
        dicePoolBN = await diceRead.bankBalance();
      } catch {
        // fallback to VIN.balanceOf(dice)
        if (vinRead) {
          dicePoolBN = await vinRead.balanceOf(DICE_CONTRACT_ADDRESS);
        }
      }
    }

    // Global Lotto pool (VIN)
    let lottoPoolBN = window.ethers.BigNumber.from(0);
    if (vinRead) {
      lottoPoolBN = await vinRead.balanceOf(LOTTO_CONTRACT_ADDRESS);
    }

    // Allowances
    let diceAllowanceBN = window.ethers.BigNumber.from(0);
    let lottoAllowanceBN = window.ethers.BigNumber.from(0);
    if (hasUser && vinRead) {
      try {
        diceAllowanceBN = await vinRead.allowance(userAddress, DICE_CONTRACT_ADDRESS);
      } catch {}
      try {
        lottoAllowanceBN = await vinRead.allowance(userAddress, LOTTO_CONTRACT_ADDRESS);
      } catch {}
    }

    // Update UI - Home balances
    setText($("vinBalance"), `${formatTokenPretty(vinBalanceBN, VIN_DECIMALS, 4)} VIN`);
    setText($("monBalance"), `${formatTokenPretty(monBalanceBN, MON_DECIMALS, 4)} MON`);
    setText($("globalDicePoolVin"), `${formatTokenPretty(dicePoolBN, VIN_DECIMALS, 2)} VIN`);
    setText($("globalLottoPoolVin"), `${formatTokenPretty(lottoPoolBN, VIN_DECIMALS, 2)} VIN`);

    // Swap panel balances (labels only, actual text built in recalcSwapOutput)
    // Dice section
    setText($("diceVinBalance"), `${formatTokenPretty(vinBalanceBN, VIN_DECIMALS, 4)} VIN`);
    setText($("diceMonBalance"), `${formatTokenPretty(monBalanceBN, MON_DECIMALS, 4)} MON`);
    setText($("dicePoolVinTop"), `${formatTokenPretty(dicePoolBN, VIN_DECIMALS, 2)} VIN`);
    setText($("dicePoolVin"), `${formatTokenPretty(dicePoolBN, VIN_DECIMALS, 2)} VIN`);
    setText($("diceAllowance"), `${formatTokenPretty(diceAllowanceBN, VIN_DECIMALS, 2)} VIN`);

    // Lotto section
    setText($("lottoVinBalance"), `${formatTokenPretty(vinBalanceBN, VIN_DECIMALS, 4)} VIN`);
    setText($("lottoMonBalance"), `${formatTokenPretty(monBalanceBN, MON_DECIMALS, 4)} MON`);
    setText($("lottoPoolVin"), `${formatTokenPretty(lottoPoolBN, VIN_DECIMALS, 2)} VIN`);
    setText($("lottoAllowance"), `${formatTokenPretty(lottoAllowanceBN, VIN_DECIMALS, 2)} VIN`);

    // Swap panel recalc
    if (typeof window.recalcSwapOutput === "function") {
      window.recalcSwapOutput();
    }
  } catch (err) {
    console.error("refreshAllBalancesAndPools error:", err);
  }
}

/* ============================================================
   SCREEN NAVIGATION
============================================================ */

function showScreen(screen) {
  activeScreen = screen;

  const screens = {
    home: $("home-screen"),
    swap: $("swap-screen"),
    dice: $("dice-screen"),
    lotto: $("lotto-screen")
  };

  Object.keys(screens).forEach((key) => {
    if (!screens[key]) return;
    if (key === screen) {
      screens[key].classList.add("screen-active");
    } else {
      screens[key].classList.remove("screen-active");
    }
  });

  // Nav buttons
  const navHome = $("navHome");
  const navSwap = $("navSwap");
  const navDice = $("navDice");
  const navLotto = $("navLotto");

  [navHome, navSwap, navDice, navLotto].forEach((btn) => {
    if (btn) btn.classList.remove("active");
  });
  if (screen === "home" && navHome) navHome.classList.add("active");
  if (screen === "swap" && navSwap) navSwap.classList.add("active");
  if (screen === "dice" && navDice) navDice.classList.add("active");
  if (screen === "lotto" && navLotto) navLotto.classList.add("active");
}

/* ============================================================
   SWAP LOGIC
============================================================ */

function setSwapDirection(direction) {
  activeSwapDirection = direction;

  const tabVinToMon = $("tabVinToMon");
  const tabMonToVin = $("tabMonToVin");
  const fromToken = $("swapFromToken");
  const toToken = $("swapToToken");

  if (direction === "VIN_TO_MON") {
    tabVinToMon?.classList.add("active");
    tabMonToVin?.classList.remove("active");
    if (fromToken) fromToken.textContent = "VIN";
    if (toToken) toToken.textContent = "MON";
  } else {
    tabVinToMon?.classList.remove("active");
    tabMonToVin?.classList.add("active");
    if (fromToken) fromToken.textContent = "MON";
    if (toToken) toToken.textContent = "VIN";
  }

  if (typeof window.recalcSwapOutput === "function") {
    window.recalcSwapOutput();
  }
}

// This function is also used from inline script in index.html
function recalcSwapOutput() {
  const fromInput = $("swapFromAmount");
  const toInput = $("swapToAmount");
  const fromBalanceLabel = $("fromBalanceLabel");
  const toBalanceLabel = $("toBalanceLabel");

  if (!fromInput || !toInput) return;

  const { utils } = window.ethers;

  const raw = String(fromInput.value || "").trim();
  let amountBN = window.ethers.BigNumber.from(0);
  if (raw) {
    const parsed = parseUnitsSafe(raw, activeSwapDirection === "VIN_TO_MON" ? VIN_DECIMALS : MON_DECIMALS);
    if (parsed) amountBN = parsed;
  }

  let resultBN;
  if (activeSwapDirection === "VIN_TO_MON") {
    resultBN = amountBN.mul(window.ethers.BigNumber.from(SWAP_RATE));
    toInput.value = resultBN.isZero()
      ? ""
      : utils.formatUnits(resultBN, MON_DECIMALS);
  } else {
    // MON -> VIN
    if (amountBN.isZero()) {
      toInput.value = "";
    } else {
      const rateBN = window.ethers.BigNumber.from(SWAP_RATE);
      resultBN = amountBN.div(rateBN);
      toInput.value = resultBN.isZero()
        ? ""
        : utils.formatUnits(resultBN, VIN_DECIMALS);
    }
  }

  // Balances in labels
  if (ethProvider && userAddress) {
    // We do not refetch here (already fetched in refreshAllBalancesAndPools),
    // but to keep labels simple we show last known text from other elements.
    // For simplicity, we will just read from the Home section and reuse.
    const vinText = $("vinBalance")?.textContent || "-";
    const monText = $("monBalance")?.textContent || "-";

    if (activeSwapDirection === "VIN_TO_MON") {
      if (fromBalanceLabel) fromBalanceLabel.textContent = `Balance: ${vinText}`;
      if (toBalanceLabel) toBalanceLabel.textContent = `Balance: ${monText}`;
    } else {
      if (fromBalanceLabel) fromBalanceLabel.textContent = `Balance: ${monText}`;
      if (toBalanceLabel) toBalanceLabel.textContent = `Balance: ${vinText}`;
    }
  } else {
    if (fromBalanceLabel) fromBalanceLabel.textContent = "Balance: -";
    if (toBalanceLabel) toBalanceLabel.textContent = "Balance: -";
  }
}

// Expose to global for inline script
window.recalcSwapOutput = recalcSwapOutput;

async function handleSwapMax() {
  if (!ethProvider || !vinRead) {
    alert("Connect your wallet first.");
    return;
  }
  if (!userAddress) {
    alert("Connect your wallet first.");
    return;
  }

  const fromInput = $("swapFromAmount");
  if (!fromInput) return;

  try {
    if (activeSwapDirection === "VIN_TO_MON") {
      const balance = await vinRead.balanceOf(userAddress);
      fromInput.value = formatUnitsRaw(balance, VIN_DECIMALS);
    } else {
      const balance = await ethProvider.getBalance(userAddress);
      fromInput.value = formatUnitsRaw(balance, MON_DECIMALS);
    }
    recalcSwapOutput();
  } catch (err) {
    console.error("handleSwapMax error:", err);
  }
}

async function handleSwapAction() {
  if (!signer || !userAddress || !swapWrite || !vinWrite) {
    alert("Connect your wallet first.");
    return;
  }

  const fromInput = $("swapFromAmount");
  if (!fromInput) return;

  const raw = String(fromInput.value || "").trim();
  if (!raw) {
    alert("Please enter an amount.");
    return;
  }

  const statusId = "swapStatus";
  setStatus(statusId, "Preparing swap...");

  try {
    const { utils, BigNumber } = window.ethers;
    if (activeSwapDirection === "VIN_TO_MON") {
      // VIN -> MON
      const vinAmountBN = parseUnitsSafe(raw, VIN_DECIMALS);
      if (!vinAmountBN || vinAmountBN.lte(0)) {
        alert("Invalid VIN amount.");
        return;
      }

      // Check allowance
      const currentAllowance = await vinRead.allowance(userAddress, SWAP_CONTRACT_ADDRESS);
      if (currentAllowance.lt(vinAmountBN)) {
        setStatus(statusId, "Approving VIN for Swap...");
        const approveAmount = utils.parseUnits("1000000", VIN_DECIMALS); // 1M
        const txApprove = await vinWrite.approve(SWAP_CONTRACT_ADDRESS, approveAmount);
        await txApprove.wait();
      }

      setStatus(statusId, "Sending swap transaction (VIN → MON)...");
      const tx = await swapWrite.swapVINtoMON(vinAmountBN);
      const receipt = await tx.wait();
      setStatus(
        statusId,
        `Swap completed. Tx: ${shortenAddress(receipt.transactionHash)}`
      );
    } else {
      // MON -> VIN (native MON)
      const monAmountBN = parseUnitsSafe(raw, MON_DECIMALS);
      if (!monAmountBN || monAmountBN.lte(0)) {
        alert("Invalid MON amount.");
        return;
      }

      if (!monAmountBN.mod(BigNumber.from(SWAP_RATE)).eq(0)) {
        alert("MON amount must be divisible by 100 (1 VIN = 100 MON).");
        return;
      }

      setStatus(statusId, "Sending swap transaction (MON → VIN)...");
      const tx = await swapWrite.swapMONtoVIN({ value: monAmountBN });
      const receipt = await tx.wait();
      setStatus(
        statusId,
        `Swap completed. Tx: ${shortenAddress(receipt.transactionHash)}`
      );
    }

    await refreshAllBalancesAndPools();
  } catch (err) {
    console.error("handleSwapAction error:", err);
    if (err.code === 4001) {
      setStatus(statusId, "User rejected transaction.");
    } else {
      setStatus(statusId, "Swap failed. Please check console for details.");
    }
  }
}

/* ============================================================
   DICE LOGIC
============================================================ */

function getSelectedDiceChoice() {
  const evenBtn = $("guessEvenButton");
  if (evenBtn && evenBtn.classList.contains("active")) return "even";
  return "odd";
}

function setDiceChoice(choice) {
  const evenBtn = $("guessEvenButton");
  const oddBtn = $("guessOddButton");

  if (choice === "even") {
    evenBtn?.classList.add("active");
    oddBtn?.classList.remove("active");
  } else {
    oddBtn?.classList.add("active");
    evenBtn?.classList.remove("active");
  }
}

async function diceApprove() {
  if (!vinWrite || !userAddress) {
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
    const tx = await vinWrite.approve(DICE_CONTRACT_ADDRESS, approveAmountBN);
    await tx.wait();
    setStatus(statusId, "Dice approval successful.");
    await refreshAllBalancesAndPools();
  } catch (err) {
    console.error("diceApprove error:", err);
    if (err.code === 4001) {
      setStatus(statusId, "User rejected approval transaction.");
    } else {
      setStatus(
        statusId,
        "Dice approval failed. Please check console for details."
      );
    }
  }
}

function startDiceVisualRolling() {
  const visual = $("diceVisual");
  if (visual) {
    visual.classList.add("dice-rolling");
  }
}

function stopDiceVisualRolling() {
  const visual = $("diceVisual");
  if (visual) {
    visual.classList.remove("dice-rolling");
  }
}

// Generate a random 4-coin pattern consistent with result (even/odd)
function generateDiceCoinsPattern(isEven) {
  // Even patterns: 0 or 2 or 4 red coins (white/red mapping is arbitrary visual)
  const evenPatterns = [
    ["white", "white", "white", "white"],
    ["red", "red", "red", "red"],
    ["white", "white", "red", "red"]
  ];
  // Odd patterns: 1 or 3 red coins
  const oddPatterns = [
    ["red", "white", "red", "red"],
    ["red", "red", "red", "white"]
  ];
  const arr = isEven ? evenPatterns : oddPatterns;
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

function applyDiceCoinsPattern(pattern) {
  const coins = document.querySelectorAll(".dice-coin");
  coins.forEach((coin, i) => {
    if (!pattern[i]) return;
    coin.classList.remove("dice-coin-white", "dice-coin-red");
    if (pattern[i] === "white") {
      coin.classList.add("dice-coin-white");
    } else {
      coin.classList.add("dice-coin-red");
    }
  });
}

async function dicePlay() {
  if (!diceWrite || !userAddress || !vinRead) {
    alert("Connect your wallet first.");
    return;
  }

  const statusId = "diceStatus";
  const amountInput = $("diceBetAmount");
  if (!amountInput) return;

  const raw = String(amountInput.value || "").trim();
  if (!raw) {
    alert("Enter bet amount.");
    return;
  }

  let amountBN = parseUnitsSafe(raw, VIN_DECIMALS);
  if (!amountBN || amountBN.lte(0)) {
    alert("Invalid bet amount.");
    return;
  }

  // Enforce MIN and MAX from contract
  try {
    const minBet = await diceRead.MIN_BET();
    const maxBet = await diceRead.MAX_BET();
    if (amountBN.lt(minBet)) {
      alert(
        `Bet amount is too small. Minimum is ${formatTokenPretty(
          minBet, VIN_DECIMALS
        , 4)} VIN`
      );
      return;
    }
    if (amountBN.gt(maxBet)) {
      alert(
        `Bet amount is too large. Maximum is ${formatTokenPretty(
          maxBet, VIN_DECIMALS
        , 4)} VIN`
      );
      return;
    }
  } catch (err) {
    console.warn("Failed to read MIN/MAX bet, using UI values only.", err);
  }

  // Check bankroll
  try {
    const bank = await diceRead.bankBalance();
    const requiredBank = amountBN.mul(2);
    if (bank.lt(requiredBank)) {
      alert("Dice bank is too small to cover this bet.");
      return;
    }
  } catch (err) {
    console.warn("Failed to read bankBalance:", err);
  }

  // Check allowance
  try {
    const allowance = await vinRead.allowance(userAddress, DICE_CONTRACT_ADDRESS);
    if (allowance.lt(amountBN)) {
      alert(
        "Your Dice allowance is lower than the bet. Please approve VIN for Dice first."
      );
      return;
    }
  } catch (err) {
    console.warn("Failed to read Dice allowance:", err);
  }

  // Determine choice
  const choiceStr = getSelectedDiceChoice();
  const choiceEnum = choiceStr === "even" ? 0 : 1;
  const clientSeed = Date.now(); // simple client seed

  setStatus(statusId, "Sending Dice transaction...");
  startDiceVisualRolling();

  try {
    const tx = await diceWrite.play(amountBN, choiceEnum, clientSeed);
    setStatus(statusId, "Waiting for Dice result on-chain...");
    const receipt = await tx.wait();

    stopDiceVisualRolling();

    // Decode Played event
    const iface = new window.ethers.utils.Interface(DICE_ABI);
    let playedEvent = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "Played") {
          if (parsed.args.player.toLowerCase() === userAddress.toLowerCase()) {
            playedEvent = parsed;
            break;
          }
        }
      } catch {
        // Not a Dice event
      }
    }

    if (!playedEvent) {
      setStatus(statusId, "Dice completed, but event not found.");
    } else {
      const amount = playedEvent.args.amount;
      const choice = playedEvent.args.choice; // 0 or 1
      const result = playedEvent.args.result; // 0 or 1
      const won = playedEvent.args.won;

      const resultStr = result === 0 ? "EVEN" : "ODD";
      const choiceStrEvent = choice === 0 ? "EVEN" : "ODD";
      const payoutBN = won ? amount.mul(2) : window.ethers.BigNumber.from(0);

      // Update coins visual to match result
      const isEven = result === 0;
      const pattern = generateDiceCoinsPattern(isEven);
      applyDiceCoinsPattern(pattern);

      // Last result section
      setText($("diceLastResult"), resultStr);
      setText($("diceLastOutcome"), `Result: ${resultStr}`);
      setText(
        $("diceLastWinLoss"),
        won ? "WIN" : "LOSE"
      );
      setText(
        $("diceLastPayout"),
        `${formatTokenPretty(payoutBN, VIN_DECIMALS, 4)} VIN`
      );
      setText(
        $("diceLastTx"),
        receipt.transactionHash || "-"
      );

      setStatus(statusId, won ? "You won! 🎉" : "You lost this round.");
    }

    // Store last bet
    lastDiceBet = {
      amount: raw,
      choice: choiceStr
    };

    await refreshAllBalancesAndPools();
  } catch (err) {
    console.error("dicePlay error:", err);
    stopDiceVisualRolling();
    if (err.code === 4001) {
      setStatus(statusId, "Dice transaction rejected by user.");
    } else {
      setStatus(
        statusId,
        "Dice play failed. This bet might revert or gas estimation failed."
      );
    }
  }
}

async function diceRefreshLastGame() {
  if (!ethProvider || !diceRead || !userAddress) {
    alert("Connect your wallet first.");
    return;
  }
  const statusId = "diceStatus";
  setStatus(statusId, "Fetching last Dice game from chain...");

  try {
    const iface = new window.ethers.utils.Interface(DICE_ABI);

    const filter = {
      address: DICE_CONTRACT_ADDRESS,
      topics: [
        iface.getEventTopic("Played"),
        window.ethers.utils.hexZeroPad(userAddress, 32)
      ],
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
    const choiceStrEvent = choice === 0 ? "EVEN" : "ODD";
    const payoutBN = won ? amount.mul(2) : window.ethers.BigNumber.from(0);

    const isEven = result === 0;
    const pattern = generateDiceCoinsPattern(isEven);
    applyDiceCoinsPattern(pattern);

    setText($("diceLastResult"), resultStr);
    setText($("diceLastOutcome"), `Result: ${resultStr}`);
    setText(
      $("diceLastWinLoss"),
      won ? "WIN" : "LOSE"
    );
    setText(
      $("diceLastPayout"),
      `${formatTokenPretty(payoutBN, VIN_DECIMALS, 4)} VIN`
    );
    setText($("diceLastTx"), lastLog.transactionHash || "-");

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

/* ============================================================
   LOTTO LOGIC
============================================================ */

function createLottoRow() {
  const container = $("lottoRows");
  if (!container) return;

  const rowIndex = lottoRowCounter++;
  const row = document.createElement("div");
  row.className = "lotto-row";

  row.innerHTML = `
    <input
      type="text"
      class="lotto-number"
      placeholder="00–99"
      maxlength="2"
    />
    <input
      type="text"
      class="lotto-amount"
      placeholder="1–50"
    />
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
  if (!vinWrite || !userAddress) {
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
    const tx = await vinWrite.approve(LOTTO_CONTRACT_ADDRESS, approveAmountBN);
    await tx.wait();
    setStatus(statusId, "Lotto approval successful.");
    await refreshAllBalancesAndPools();
  } catch (err) {
    console.error("lottoApprove error:", err);
    if (err.code === 4001) {
      setStatus(statusId, "User rejected approval transaction.");
    } else {
      setStatus(
        statusId,
        "Lotto approval failed. Please check console for details."
      );
    }
  }
}

async function lottoPlay() {
  if (!lottoWrite || !userAddress || !vinRead) {
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

  const { utils } = window.ethers;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const numInput = row.querySelector(".lotto-number");
    const amountInput = row.querySelector(".lotto-amount");
    const radios = row.querySelectorAll('input[type="radio"]');

    if (!numInput || !amountInput || !radios.length) continue;

    const numRaw = String(numInput.value || "").trim();
    const amtRaw = String(amountInput.value || "").trim();
    if (!numRaw || !amtRaw) continue;

    const numVal = parseInt(numRaw, 10);
    if (isNaN(numVal) || numVal < 0 || numVal > 99) {
      alert("Each number must be between 00 and 99.");
      return;
    }

    const amtBN = parseUnitsSafe(amtRaw, VIN_DECIMALS);
    if (!amtBN || amtBN.lte(0)) {
      alert("Each bet amount must be greater than 0.");
      return;
    }

    // Determine betType
    let betType = 0; // 0 = BetOne, 1 = Bet27
    radios.forEach((r) => {
      if (r.checked && r.value === "bet27") {
        betType = 1;
      }
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

  // Minimum bet per row from contract
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

  // Check VIN allowance
  try {
    const allowance = await vinRead.allowance(userAddress, LOTTO_CONTRACT_ADDRESS);
    if (allowance.lt(totalBetBN)) {
      alert(
        "Your Lotto allowance is lower than total bet. Please approve VIN for Lotto first."
      );
      return;
    }
  } catch (err) {
    console.warn("Failed to read Lotto allowance:", err);
  }

  // Check user VIN balance
  try {
    const balance = await vinRead.balanceOf(userAddress);
    if (balance.lt(totalBetBN)) {
      alert("Your VIN balance is not enough for this total bet.");
      return;
    }
  } catch (err) {
    console.warn("Failed to read VIN balance:", err);
  }

  // Call play
  setStatus(
    statusId,
    "Sending Lotto transaction... (27 draws will be computed on-chain)"
  );

  try {
    // Pass as array of objects matching (uint8 number, uint256 amount, uint8 betType)
    const tx = await lottoWrite.play(bets);
    setStatus(statusId, "Waiting for Lotto result on-chain...");
    const receipt = await tx.wait();

    // Decode Played event
    const iface = new window.ethers.utils.Interface(LOTTO_ABI);
    let playedEvent = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "Played") {
          if (parsed.args.player.toLowerCase() === userAddress.toLowerCase()) {
            playedEvent = parsed;
            break;
          }
        }
      } catch {
        // Not Lotto event
      }
    }

    if (!playedEvent) {
      setStatus(statusId, "Lotto completed, but Played event not found.");
      return;
    }

    const results = playedEvent.args.results; // uint8[27]
    const totalBet = playedEvent.args.totalBet;
    const totalPayout = playedEvent.args.totalPayout;

    // Build result text
    const finalResult = results[results.length - 1];
    const allResultsText = Array.from(results).join(", ");

    let html = "";
    html += `<p><strong>Tx:</strong> ${receipt.transactionHash}</p>`;
    html += `<p><strong>Total bet:</strong> ${formatTokenPretty(
      totalBet, VIN_DECIMALS
    , 4)} VIN</p>`;
    html += `<p><strong>Total payout:</strong> ${formatTokenPretty(
      totalPayout, VIN_DECIMALS
    , 4)} VIN</p>`;
    html += `<p><strong>27 draws (0–99):</strong> [${allResultsText}]</p>`;
    html += `<p><strong>Final result (27th draw):</strong> ${finalResult}</p>`;

    // Show bets
    html += `<hr/><p><strong>Your bets:</strong></p><ul>`;
    bets.forEach((b, idx) => {
      html += `<li>Row ${idx + 1}: number ${b.number}, amount ${formatTokenPretty(
        b.amount, VIN_DECIMALS
      , 4)} VIN, type ${b.betType === 0 ? "BetOne" : "Bet27"}</li>`;
    });
    html += `</ul>`;

    const detailEl = $("lottoResultDetail");
    if (detailEl) {
      detailEl.innerHTML = html;
    }

    setStatus(statusId, "Lotto round finished.");
    lastLottoBets = bets;

    await refreshAllBalancesAndPools();
  } catch (err) {
    console.error("lottoPlay error:", err);
    if (err.code === 4001) {
      setStatus(statusId, "Lotto transaction rejected by user.");
    } else {
      setStatus(
        statusId,
        "Lotto play failed. This bet might revert or gas estimation failed."
      );
    }
  }
}

async function lottoDecodePastTx() {
  if (!ethProvider) {
    ethProvider = new window.ethers.providers.JsonRpcProvider(RPC_URL);
  }

  const input = $("lottoTxHashInput");
  const detailEl = $("lottoResultDetail");
  if (!input || !detailEl) return;

  const txHash = String(input.value || "").trim();
  if (!txHash) {
    alert("Paste a transaction hash.");
    return;
  }

  setStatus("lottoStatus", "Decoding transaction from chain...");

  try {
    const receipt = await ethProvider.getTransactionReceipt(txHash);
    if (!receipt) {
      detailEl.innerHTML = "Transaction not found.";
      return;
    }

    const iface = new window.ethers.utils.Interface(LOTTO_ABI);
    let playedEvent = null;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== LOTTO_CONTRACT_ADDRESS.toLowerCase()) {
        continue;
      }
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "Played") {
          playedEvent = parsed;
          break;
        }
      } catch {
        // Not a Played event
      }
    }

    if (!playedEvent) {
      detailEl.innerHTML = "No Lotto Played event found in this transaction.";
      return;
    }

    const player = playedEvent.args.player;
    const bets = playedEvent.args.bets;
    const results = playedEvent.args.results;
    const totalBet = playedEvent.args.totalBet;
    const totalPayout = playedEvent.args.totalPayout;
    const finalResult = results[results.length - 1];
    const allResultsText = Array.from(results).join(", ");

    let html = "";
    html += `<p><strong>Player:</strong> ${player}</p>`;
    html += `<p><strong>Total bet:</strong> ${formatTokenPretty(
      totalBet, VIN_DECIMALS
    , 4)} VIN</p>`;
    html += `<p><strong>Total payout:</strong> ${formatTokenPretty(
      totalPayout, VIN_DECIMALS
    , 4)} VIN</p>`;
    html += `<p><strong>27 draws (0–99):</strong> [${allResultsText}]</p>`;
    html += `<p><strong>Final result (27th draw):</strong> ${finalResult}</p>`;

    html += `<hr/><p><strong>Bets:</strong></p><ul>`;
    bets.forEach((b, idx) => {
      html += `<li>Row ${idx + 1}: number ${b.number}, amount ${formatTokenPretty(
        b.amount, VIN_DECIMALS
      , 4)} VIN, type ${b.betType === 0 ? "BetOne" : "Bet27"}</li>`;
    });
    html += `</ul>`;

    detailEl.innerHTML = html;
    setStatus("lottoStatus", "Decode complete.");
  } catch (err) {
    console.error("lottoDecodePastTx error:", err);
    detailEl.innerHTML = "Failed to decode this transaction.";
    setStatus("lottoStatus", "Decode failed.");
  }
}

/* ============================================================
   EVENT LISTENERS & INIT
============================================================ */

function setupEventListeners() {
  // Navigation
  $("navHome")?.addEventListener("click", () => showScreen("home"));
  $("navSwap")?.addEventListener("click", () => showScreen("swap"));
  $("navDice")?.addEventListener("click", () => showScreen("dice"));
  $("navLotto")?.addEventListener("click", () => showScreen("lotto"));

  $("goToSwap")?.addEventListener("click", () => showScreen("swap"));
  $("goToDice")?.addEventListener("click", () => showScreen("dice"));
  $("goToLotto")?.addEventListener("click", () => showScreen("lotto"));

  // Connect wallet
  $("connectButton")?.addEventListener("click", connectWallet);

  // Refresh balances
  $("refreshBalances")?.addEventListener("click", refreshAllBalancesAndPools);

  // Swap
  $("tabVinToMon")?.addEventListener("click", () =>
    setSwapDirection("VIN_TO_MON")
  );
  $("tabMonToVin")?.addEventListener("click", () =>
    setSwapDirection("MON_TO_VIN")
  );
  $("swapFromAmount")?.addEventListener("input", () => recalcSwapOutput());
  $("swapMaxButton")?.addEventListener("click", handleSwapMax);
  $("swapActionButton")?.addEventListener("click", handleSwapAction);

  // Dice
  $("diceApproveButton")?.addEventListener("click", diceApprove);
  $("dicePlayButton")?.addEventListener("click", dicePlay);
  $("diceMaxButton")?.addEventListener("click", async () => {
    if (!vinRead || !userAddress) {
      alert("Connect your wallet first.");
      return;
    }
    try {
      const bal = await vinRead.balanceOf(userAddress);
      $("diceBetAmount").value = formatUnitsRaw(bal, VIN_DECIMALS);
    } catch (err) {
      console.error("diceMaxButton error:", err);
    }
  });

  $("guessEvenButton")?.addEventListener("click", () => {
    setDiceChoice("even");
  });
  $("guessOddButton")?.addEventListener("click", () => {
    setDiceChoice("odd");
  });

  $("diceRepeatButton")?.addEventListener("click", diceQuickRepeat);
  $("diceHalfButton")?.addEventListener("click", diceQuickHalf);
  $("diceDoubleButton")?.addEventListener("click", diceQuickDouble);
  $("diceClearButton")?.addEventListener("click", diceQuickClear);
  $("diceRefreshLast")?.addEventListener("click", diceRefreshLastGame);

  // Lotto
  $("addLottoRow")?.addEventListener("click", () => {
    createLottoRow();
  });

  // Remove row (event delegation)
  $("lottoRows")?.addEventListener("click", (e) => {
    const target = e.target;
    if (target.classList.contains("btn-remove-row")) {
      const row = target.closest(".lotto-row");
      if (row) {
        row.remove();
        refreshLottoTotalBet();
      }
    }
  });

  // Lotto amount inputs -> refresh total
  $("lottoRows")?.addEventListener("input", (e) => {
    if (e.target.classList.contains("lotto-amount")) {
      refreshLottoTotalBet();
    }
  });

  $("lottoHalf")?.addEventListener("click", lottoQuickHalf);
  $("lottoDouble")?.addEventListener("click", lottoQuickDouble);
  $("lottoClear")?.addEventListener("click", lottoQuickClear);

  $("lottoApproveButton")?.addEventListener("click", lottoApprove);
  $("lottoPlayButton")?.addEventListener("click", lottoPlay);
  $("decodeLottoTx")?.addEventListener("click", lottoDecodePastTx);
}

async function initApp() {
  if (!window.ethers) {
    console.error("ethers.js not found. Make sure CDN is loaded before app.js.");
    return;
  }

  // Initial state
  showScreen("home");
  setSwapDirection("VIN_TO_MON");
  setDiceChoice("even");

  updateNetworkIndicatorDisconnected();
  updateWalletUI();

  // Setup static event listeners once
  setupEventListeners();

  // Initialize default Lotto total (for default row)
  refreshLottoTotalBet();

  // Always create a read-only provider first (fast pool reads even without wallet)
  try {
    ethProvider = new window.ethers.providers.JsonRpcProvider(RPC_URL);
    initReadContracts(); // read-only contracts for pool/balance reads before wallet connects
    await syncVinDecimalsRead();
    await refreshAllBalancesAndPools();
  } catch (err) {
    console.error("Initial RPC sync error:", err);
  }

  // Auto-detect already-connected wallet (no popup)
  try {
    const eth = window.ethereum;
    if (eth && eth.request) {
      setupWalletEventListeners(); // set listeners early
      const accounts = await eth.request({ method: "eth_accounts" });
      const chainIdHex = await eth.request({ method: "eth_chainId" });
      const chainDec = parseInt(chainIdHex, 16);

      if (accounts && accounts.length) {
        userAddress = window.ethers.utils.getAddress(accounts[0]);
        ethProvider = new window.ethers.providers.Web3Provider(eth, "any");
        signer = ethProvider.getSigner();
        initContracts();
        await syncVinDecimals();

        if (chainDec === MONAD_CHAIN_ID_DEC) updateNetworkIndicatorConnected();
        else updateNetworkIndicatorWrong();

        updateWalletUI();
        await refreshAllBalancesAndPools();
      } else {
        // No wallet connected yet, still reflect network if user is on Monad in wallet
        if (chainDec === MONAD_CHAIN_ID_DEC) {
          // show Monad even if not connected (wallet not authorized)
          // comment out next line if you prefer "Not connected" until user connects
          // updateNetworkIndicatorConnected();
        }
      }
    }
  } catch (e) {
    // ignore
  }
}

window.addEventListener("load", initApp);
