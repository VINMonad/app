/* =========================================================
   VINMonad dApp
   Network: Monad (chainId 143)
   Tech: ethers.js v5
   ========================================================= */

/* ================= CONFIG ================= */
const CHAIN_ID = 143;
const CHAIN_ID_HEX = "0x8f";
const RPC_URL = "https://rpc.monad.xyz";

// Contracts
const VIN_ADDRESS = "0x038A2f1abe221d403834aa775669169Ef5eb120A";
const VIN_SWAP_ADDRESS = "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB";
const VIN_DICE_ADDRESS = "0xf2b1C0A522211949Ad2671b0F4bF92547d66ef3A";
const VIN_LOTTO_ADDRESS = "0x84392F14fCeCEEe31a5Fd69BfD0Dd2a9AAF364E5";

const VIN_DECIMALS = 18;
const MON_DECIMALS = 18;

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);

// Header / wallet
const connectBtn = $("connectWallet");
const walletAddressEl = $("walletAddress");
const vinBalanceEl = $("vinBalance");
const monBalanceEl = $("monBalance");

// Pages
const pages = {
  home: $("home"),
  swap: $("swap"),
  dice: $("dice"),
  lotto: $("lotto"),
};

// Menu buttons
const menuButtons = {
  home: $("menuHome"),
  swap: $("menuSwap"),
  dice: $("menuDice"),
  lotto: $("menuLotto"),
};

/* ================= STATE ================= */
let provider;
let signer;
let userAddress;

// Contracts
let vinRead, vinWrite;
let swapWrite;
let diceWrite;
let lottoWrite;

/* ================= ABIs ================= */
const VIN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const VIN_SWAP_ABI = [
  "function swapVINtoMON(uint256 vinAmount)",
  "function swapMONtoVIN() payable",
];

const VIN_DICE_ABI = [
  "function play(uint256 amount, uint8 choice, uint256 clientSeed)",
];

const VIN_LOTTO_ABI = [
  "function placeBet(uint256 amount,uint8[] numbers,bytes32 commit,bool isBet27)",
  "function reveal(bytes32 secret)",
];

/* ================= HELPERS ================= */
function shorten(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function parseVin(val) {
  return ethers.utils.parseUnits(val || "0", VIN_DECIMALS);
}

function formatVin(bn) {
  return ethers.utils.formatUnits(bn || 0, VIN_DECIMALS);
}

function formatMon(bn) {
  return ethers.utils.formatEther(bn || 0);
}

function randomSeed() {
  return Math.floor(Math.random() * 1e16);
}

/* ================= MENU ================= */
function showPage(page) {
  Object.values(pages).forEach((p) => p.classList.remove("active"));
  Object.values(menuButtons).forEach((b) => b.classList.remove("active"));

  pages[page].classList.add("active");
  menuButtons[page].classList.add("active");
}

menuButtons.home.onclick = () => showPage("home");
menuButtons.swap.onclick = () => showPage("swap");
menuButtons.dice.onclick = () => showPage("dice");
menuButtons.lotto.onclick = () => showPage("lotto");

document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.onclick = () => showPage(btn.dataset.go);
});

/* ================= NETWORK ================= */
async function ensureNetwork() {
  const cid = await window.ethereum.request({ method: "eth_chainId" });
  if (cid === CHAIN_ID_HEX) return;

  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: CHAIN_ID_HEX }],
  });
}

/* ================= WALLET ================= */
async function connectWallet() {
  if (!window.ethereum) {
    alert("Wallet not found");
    return;
  }

  await ensureNetwork();

  provider = new ethers.providers.Web3Provider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = provider.getSigner();
  userAddress = await signer.getAddress();

  walletAddressEl.textContent = shorten(userAddress);
  connectBtn.textContent = "Connected";

  initContracts();
  await refreshBalances();
}

connectBtn.onclick = connectWallet;

if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => location.reload());
}

/* ================= CONTRACT INIT ================= */
function initContracts() {
  const rpc = new ethers.providers.JsonRpcProvider(RPC_URL);

  vinRead = new ethers.Contract(VIN_ADDRESS, VIN_ABI, rpc);
  vinWrite = new ethers.Contract(VIN_ADDRESS, VIN_ABI, signer);

  swapWrite = new ethers.Contract(VIN_SWAP_ADDRESS, VIN_SWAP_ABI, signer);
  diceWrite = new ethers.Contract(VIN_DICE_ADDRESS, VIN_DICE_ABI, signer);
  lottoWrite = new ethers.Contract(VIN_LOTTO_ADDRESS, VIN_LOTTO_ABI, signer);
}

/* ================= BALANCES ================= */
async function refreshBalances() {
  if (!userAddress) return;

  const [vinBal, monBal] = await Promise.all([
    vinRead.balanceOf(userAddress),
    provider.getBalance(userAddress),
  ]);

  vinBalanceEl.textContent = formatVin(vinBal);
  monBalanceEl.textContent = formatMon(monBal);
}

/* =================================================
   SWAP
   ================================================= */
function initSwap() {
  const container = $("swap-container");
  if (!container) return;

  container.innerHTML = `
    <input id="swapAmount" placeholder="VIN or MON" />
    <button id="swapVinToMon">VIN → MON</button>
    <button id="swapMonToVin">MON → VIN</button>
    <div id="swapStatus" class="tx-status">–</div>
  `;

  $("swapVinToMon").onclick = async () => {
    try {
      const amt = parseVin($("swapAmount").value);
      const allowance = await vinRead.allowance(userAddress, VIN_SWAP_ADDRESS);

      if (allowance.lt(amt)) {
        await (await vinWrite.approve(VIN_SWAP_ADDRESS, ethers.constants.MaxUint256)).wait();
      }

      $("swapStatus").textContent = "Swapping VIN → MON...";
      await (await swapWrite.swapVINtoMON(amt)).wait();
      $("swapStatus").textContent = "Done";
      refreshBalances();
    } catch (e) {
      $("swapStatus").textContent = "Swap failed";
    }
  };

  $("swapMonToVin").onclick = async () => {
    try {
      const amt = ethers.utils.parseEther($("swapAmount").value || "0");
      $("swapStatus").textContent = "Swapping MON → VIN...";
      await (await swapWrite.swapMONtoVIN({ value: amt })).wait();
      $("swapStatus").textContent = "Done";
      refreshBalances();
    } catch {
      $("swapStatus").textContent = "Swap failed";
    }
  };
}

/* =================================================
   DICE
   ================================================= */
function initDice() {
  const container = $("dice-container");
  if (!container) return;

  container.innerHTML = `
    <input id="diceAmount" placeholder="VIN amount" />
    <button id="diceEven">Even</button>
    <button id="diceOdd">Odd</button>
    <div id="diceStatus" class="tx-status">–</div>
  `;

  async function play(choice) {
    try {
      const amt = parseVin($("diceAmount").value);
      const allowance = await vinRead.allowance(userAddress, VIN_DICE_ADDRESS);

      if (allowance.lt(amt)) {
        await (await vinWrite.approve(VIN_DICE_ADDRESS, ethers.constants.MaxUint256)).wait();
      }

      $("diceStatus").textContent = "Rolling...";
      await (await diceWrite.play(amt, choice, randomSeed())).wait();
      $("diceStatus").textContent = "Done";
      refreshBalances();
    } catch {
      $("diceStatus").textContent = "Failed";
    }
  }

  $("diceEven").onclick = () => play(0);
  $("diceOdd").onclick = () => play(1);
}

/* =================================================
   LOTTO (Commit–Reveal)
   ================================================= */
function initLotto() {
  const rows = $("lottoRows");
  const status = $("lottoStatus");
  const result = $("lottoResult");

  let secret;

  function addRow(num = "", vin = "") {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input value="${num}" /></td>
      <td><input value="${vin}" /></td>
      <td><button class="remove">×</button></td>
    `;
    tr.querySelector(".remove").onclick = () => tr.remove();
    rows.appendChild(tr);
  }

  $("lottoAdd").onclick = () => addRow();

  $("lottoClear").onclick = () => {
    rows.innerHTML = "";
    result.textContent = "";
  };

  $("lottoPlay").onclick = async () => {
    try {
      const isBet27 =
        document.querySelector("input[name=lottoType]:checked").value === "bet27";

      const nums = [];
      let total = ethers.BigNumber.from(0);

      rows.querySelectorAll("tr").forEach((tr) => {
        const n = Number(tr.children[0].firstElementChild.value);
        const v = parseVin(tr.children[1].firstElementChild.value);
        nums.push(n);
        total = total.add(v);
      });

      secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      const commit = ethers.utils.keccak256(secret);

      const allowance = await vinRead.allowance(userAddress, VIN_LOTTO_ADDRESS);
      if (allowance.lt(total)) {
        await (await vinWrite.approve(VIN_LOTTO_ADDRESS, ethers.constants.MaxUint256)).wait();
      }

      status.textContent = "Placing bet...";
      await (await lottoWrite.placeBet(total, nums, commit, isBet27)).wait();

      status.textContent = "Waiting blocks...";
      setTimeout(async () => {
        status.textContent = "Revealing...";
        await (await lottoWrite.reveal(secret)).wait();
        status.textContent = "Done";
        refreshBalances();
      }, 15000);
    } catch {
      status.textContent = "Lotto failed";
    }
  };

  addRow();
}

/* ================= INIT ================= */
async function init() {
  if (!window.ethereum) return;
  provider = new ethers.providers.Web3Provider(window.ethereum);
  const accs = await provider.listAccounts();
  if (accs.length) {
    signer = provider.getSigner();
    userAddress = accs[0];
    walletAddressEl.textContent = shorten(userAddress);
    connectBtn.textContent = "Connected";
    initContracts();
    refreshBalances();
  }

  initSwap();
  initDice();
  initLotto();
}

init();
