// ================= CONFIG =================
const CHAIN_ID = 143;

// Contracts
const VIN_ADDRESS = "0x038A2f1abe221d403834aa775669169Ef5eb120A";
const VIN_DECIMALS = 18;

// Elements
const connectBtn = document.getElementById("connectWallet");
const walletAddressEl = document.getElementById("walletAddress");
const vinBalanceEl = document.getElementById("vinBalance");
const monBalanceEl = document.getElementById("monBalance");

// Pages
const pages = {
  home: document.getElementById("home"),
  swap: document.getElementById("swap"),
  dice: document.getElementById("dice"),
  lotto: document.getElementById("lotto"),
};

// Menu buttons
const menuButtons = {
  home: document.getElementById("menuHome"),
  swap: document.getElementById("menuSwap"),
  dice: document.getElementById("menuDice"),
  lotto: document.getElementById("menuLotto"),
};

// ================= GLOBAL STATE =================
let provider;
let signer;
let userAddress;

// ================= MENU HANDLING =================
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

// Home quick buttons
document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.onclick = () => showPage(btn.dataset.go);
});

// ================= WALLET =================
async function connectWallet() {
  if (!window.ethereum) {
    alert("MetaMask not found");
    return;
  }

  provider = new ethers.providers.Web3Provider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = provider.getSigner();
  userAddress = await signer.getAddress();

  walletAddressEl.textContent =
    userAddress.slice(0, 6) + "..." + userAddress.slice(-4);

  connectBtn.textContent = "Connected";

  await refreshBalances();
}

connectBtn.onclick = connectWallet;

// ================= BALANCES =================
async function refreshBalances() {
  if (!provider || !userAddress) return;

  // MON balance
  const mon = await provider.getBalance(userAddress);
  monBalanceEl.textContent = ethers.utils.formatEther(mon);

  // VIN balance
  const vin = new ethers.Contract(
    VIN_ADDRESS,
    [
      "function balanceOf(address) view returns (uint256)",
    ],
    provider
  );

  const vinBal = await vin.balanceOf(userAddress);
  vinBalanceEl.textContent = ethers.utils.formatUnits(vinBal, VIN_DECIMALS);
}

// ================= AUTO CONNECT =================
if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => location.reload());
}
