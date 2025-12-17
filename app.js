// Define contract addresses and ABI
const VIN_ADDRESS = "0x038A2f1abe221d403834aa775669169Ef5eb120A";
const VIN_SWAP_ADDRESS = "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB";
const VINDICEV3_ADDRESS = "0xB8D7D799eE31FedD38e63801419782E8110326E4";
const VINLOTTO_ADDRESS = "0x59348366C6724EbBB16d429A2af57cC0b2E34A75";

// Ethereum provider
let provider = new ethers.providers.Web3Provider(window.ethereum);
let signer;
let vinSwapContract, vinDiceContract, vinLottoContract;

// ABI for contracts (included directly in app.js)
const VINSwapABI = [
    {
        "inputs": [{"internalType": "address", "name": "vinToken", "type": "address"}],
        "stateMutability": "nonpayable",
        "type": "constructor"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "address", "name": "user", "type": "address"},
            {"indexed": false, "internalType": "uint256", "name": "vinIn", "type": "uint256"},
            {"indexed": false, "internalType": "uint256", "name": "monOut", "type": "uint256"}
        ],
        "name": "SwapVINtoMON",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "address", "name": "user", "type": "address"},
            {"indexed": false, "internalType": "uint256", "name": "monIn", "type": "uint256"},
            {"indexed": false, "internalType": "uint256", "name": "vinOut", "type": "uint256"}
        ],
        "name": "SwapMONtoVIN",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "RATE",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"internalType": "uint256", "name": "vinAmount", "type": "uint256"}],
        "name": "swapVINtoMON",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "swapMONtoVIN",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    }
];

const VINDiceV3ABI = [
    {
        "inputs": [],
        "stateMutability": "nonpayable",
        "type": "constructor"
    },
    {
        "inputs": [{"internalType": "address", "name": "player", "type": "address"}],
        "name": "Played",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "play",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "bankBalance",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    }
];

const VINLottoV1ABI = [
    {
        "inputs": [{"internalType": "address", "name": "player", "type": "address"}],
        "name": "Played",
        "type": "event"
    },
    {
        "inputs": [{"internalType": "bool", "name": "bet27", "type": "bool"}],
        "name": "play",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "withdraw",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// Connect to the user's wallet
async function connectWallet() {
    try {
        await provider.send("eth_requestAccounts", []);
        signer = provider.getSigner();
        document.getElementById("connectBtn").innerText = "Connected";
        document.getElementById("connectBtn").classList.add("connected");

        // Instantiate contracts
        vinSwapContract = new ethers.Contract(VIN_SWAP_ADDRESS, VINSwapABI, signer);
        vinDiceContract = new ethers.Contract(VINDICEV3_ADDRESS, VINDiceV3ABI, signer);
        vinLottoContract = new ethers.Contract(VINLOTTO_ADDRESS, VINLottoV1ABI, signer);

        // Display wallet address
        let address = await signer.getAddress();
        document.getElementById("walletShort").innerText = `${address.slice(0, 6)}...${address.slice(-4)}`;

        updateBalance();
    } catch (err) {
        console.error("Connection failed:", err);
    }
}

// Fetch the VIN balance of the connected wallet
async function updateBalance() {
    const vinBalance = await vinSwapContract.balanceOf(await signer.getAddress());
    document.getElementById("homeVinBal").innerText = ethers.utils.formatUnits(vinBalance, 18);
    const monBalance = await provider.getBalance(await signer.getAddress());
    document.getElementById("homeMonBal").innerText = ethers.utils.formatUnits(monBalance, 18);
}

// Swap VIN ↔ MON
async function swapVINtoMON() {
    let amount = document.getElementById("swapFromAmt").value;
    let amountInWei = ethers.utils.parseUnits(amount, 18);
    try {
        await vinSwapContract.swapVINtoMON(amountInWei);
        updateBalance();
        alert("Swap Successful!");
    } catch (err) {
        console.error("Swap failed:", err);
    }
}

// Swap MON ↔ VIN
async function swapMONtoVIN() {
    let amount = document.getElementById("swapFromAmt").value;
    let amountInWei = ethers.utils.parseUnits(amount, 18);
    try {
        await vinSwapContract.swapMONtoVIN({ value: amountInWei });
        updateBalance();
        alert("Swap Successful!");
    } catch (err) {
        console.error("Swap failed:", err);
    }
}

// Play Dice (Even/Odd)
async function playDice() {
    let betAmount = document.getElementById("diceBetAmt").value;
    let choice = document.getElementById("diceEvenBtn").classList.contains("active") ? 0 : 1; // Even = 0, Odd = 1
    let clientSeed = Math.floor(Math.random() * 1000); // Random seed for client-side randomness

    try {
        await vinDiceContract.play(ethers.utils.parseUnits(betAmount, 18), choice, clientSeed);
        alert("Dice Played!");
    } catch (err) {
        console.error("Dice play failed:", err);
    }
}

// Play Lotto (BetOne / Bet27)
async function playLotto() {
    let betOne = document.getElementById("lottoTabBetOne").classList.contains("active");
    let numbers = [];
    let amounts = [];
    document.querySelectorAll(".lottoNumber").forEach(input => numbers.push(parseInt(input.value)));
    document.querySelectorAll(".lottoAmount").forEach(input => amounts.push(ethers.utils.parseUnits(input.value, 18)));

    try {
        await vinLottoContract.play(betOne, numbers, amounts);
        alert("Lotto Played!");
    } catch (err) {
        console.error("Lotto play failed:", err);
    }
}

// Event listeners for actions
document.getElementById("connectBtn").addEventListener("click", connectWallet);
document.getElementById("swapBtn").addEventListener("click", swapVINtoMON);
document.getElementById("swapRefreshBtn").addEventListener("click", updateBalance);
document.getElementById("dicePlayBtn").addEventListener("click", playDice);
document.getElementById("lottoPlayBtn").addEventListener("click", playLotto);

// Additional helpers can be added here, like managing UI states
