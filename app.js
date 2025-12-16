/* =========================================================
   VINMonad — app.js (English-only)
   - Chain: Monad (chainId 143)
   - VIN/USD chip: MON price from CoinGecko × 100
   - Swap: shows rate dynamically (no "fixed" text)
   - Dice: MIN/MAX + visualization (white/red coins)
   - Lotto: BetOne / Bet27 commit–reveal
   ========================================================= */

(() => {
  "use strict";

  // -----------------------
  // Constants
  // -----------------------
  const CHAIN_ID_DEC = 143;
  const CHAIN_ID_HEX = "0x8f";
  const CHAIN_NAME = "Monad";
  const RPC_URL = "https://rpc.monad.xyz";
  const EXPLORER = "https://monad.blockscout.com";

  const ADDR = {
    VIN: "0x038A2f1abe221d403834aa775669169Ef5eb120A",
    SWAP: "0x73a8C8Bf994A53DaBb9aE707cD7555DFD1909fbB",
    DICE: "0xf2b1C0A522211949Ad2671b0F4bF92547d66ef3A",
    LOTTO: "0x84392F14fCeCEEe31a5Fd69BfD0Dd2a9AAF364E5",
  };

  // IMPORTANT: You requested to compute VIN/USD as MONUSD × 100
  // (and also use that for the "rate" shown in Swap).
  const VIN_PER_MON = 0.01; // 1 MON = 0.01 VIN
  const MON_PER_VIN = 100;  // 1 VIN = 100 MON

  const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];

  // ABI from your uploaded JSONs (embedded here for GitHub single-file ease)
  const SWAP_ABI = [
    {
      inputs: [],
      name: "RATE",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "VIN",
      outputs: [{ internalType: "contract IERC20", name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "owner",
      outputs: [{ internalType: "address", name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "swapMONtoVIN",
      outputs: [],
      stateMutability: "payable",
      type: "function",
    },
    {
      inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
      name: "swapVINtoMON",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      inputs: [],
      name: "withdraw",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    { stateMutability: "payable", type: "receive" },
  ];

  const DICE_ABI = [
    {
      inputs: [],
      name: "MAX_BET",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "MIN_BET",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "VIN",
      outputs: [{ internalType: "contract IERC20", name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "bankBalance",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
      name: "maxBetAllowed",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "owner",
      outputs: [{ internalType: "address", name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [
        { internalType: "uint256", name: "amount", type: "uint256" },
        { internalType: "uint8", name: "choice", type: "uint8" },
        { internalType: "uint256", name: "clientSeed", type: "uint256" },
      ],
      name: "play",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      inputs: [],
      name: "withdraw",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      anonymous: false,
      inputs: [
        { indexed: true, internalType: "address", name: "player", type: "address" },
        { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
        { indexed: false, internalType: "uint8", name: "choice", type: "uint8" },
        { indexed: false, internalType: "uint8", name: "diceResult", type: "uint8" },
        { indexed: false, internalType: "uint16", name: "roll", type: "uint16" },
        { indexed: false, internalType: "bool", name: "won", type: "bool" },
      ],
      name: "Played",
      type: "event",
    },
  ];

  const LOTTO_ABI = [
    {
      inputs: [],
      name: "MIN_BET",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "REVEAL_DELAY",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "VIN",
      outputs: [{ internalType: "contract IERC20", name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "bankBalance",
      outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [{ internalType: "address", name: "", type: "address" }],
      name: "bets",
      outputs: [
        { internalType: "uint256", name: "amount", type: "uint256" },
        { internalType: "uint256", name: "commitBlock", type: "uint256" },
        { internalType: "bytes32", name: "commit", type: "bytes32" },
        { internalType: "bool", name: "isBet27", type: "bool" },
      ],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [],
      name: "owner",
      outputs: [{ internalType: "address", name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
    {
      inputs: [
        { internalType: "uint256", name: "amount", type: "uint256" },
        { internalType: "uint8[]", name: "numbers", type: "uint8[]" },
        { internalType: "bytes32", name: "commit", type: "bytes32" },
        { internalType: "bool", name: "isBet27", type: "bool" },
      ],
      name: "placeBet",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      inputs: [{ internalType: "bytes32", name: "secret", type: "bytes32" }],
      name: "reveal",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      inputs: [],
      name: "withdraw",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
    {
      anonymous: false,
      inputs: [
        { indexed: true, internalType: "address", name: "player", type: "address" },
        { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
        { indexed: false, internalType: "bytes32", name: "commit", type: "bytes32" },
        { indexed: false, internalType: "bool", name: "isBet27", type: "bool" },
      ],
      name: "BetPlaced",
      type: "event",
    },
    {
      anonymous: false,
      inputs: [
        { indexed: true, internalType: "address", name: "player", type: "address" },
        { indexed: false, internalType: "bool", name: "isBet27", type: "bool" },
        { indexed: false, internalType: "uint256", name: "payout", type: "uint256" },
      ],
      name: "BetRevealed",
      type: "event",
    },
  ];

  // -----------------------
  // UI helpers
  // -----------------------
  const $ = (id) => document.getElementById(id);

  function shortAddr(a) {
    if (!a || typeof a !== "string") return "-";
    return a.slice(0, 6) + "..." + a.slice(-4);
  }

  function safeText(el, txt) {
    if (!el) return;
    el.textContent = txt;
  }

  function toNum(str) {
    const s = (str || "").trim().replace(/,/g, "");
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  function fmt(n, dp = 4) {
    if (n === null || n === undefined) return "-";
    const x = Number(n);
    if (!Number.isFinite(x)) return "-";
    return x.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: dp,
    });
  }

  function fmtFixed(n, dp = 6) {
    if (n === null || n === undefined) return "-";
    const x = Number(n);
    if (!Number.isFinite(x)) return "-";
    return x.toFixed(dp);
  }

  function setConnectedDot(isConnected) {
    const dot = $("netDot");
    const label = $("netLabel");
    if (!dot || !label) return;
    dot.classList.remove("dot-disconnected", "dot-connected");
    dot.classList.add(isConnected ? "dot-connected" : "dot-disconnected");
    safeText(label, isConnected ? CHAIN_NAME : "Not connected");
  }

  // -----------------------
  // State
  // -----------------------
  let provider = null;
  let signer = null;
  let user = null;

  let vin = null;
  let swap = null;
  let dice = null;
  let lotto = null;

  let vinDecimals = 18;

  // Dice constants
  let DICE_MIN = 1;
  let DICE_MAX = 50;

  // Lotto constants
  let LOTTO_MIN = 1;
  let LOTTO_REVEAL_DELAY = 0;

  // Swap direction
  // true: VIN -> MON, false: MON -> VIN
  let isVinToMon = true;

  // Lotto mode
  // false: BetOne, true: Bet27
  let isBet27 = false;

  // -----------------------
  // Screens / Nav
  // -----------------------
  const screens = [
    { nav: "navHome", screen: "home-screen" },
    { nav: "navSwap", screen: "swap-screen" },
    { nav: "navDice", screen: "dice-screen" },
    { nav: "navLotto", screen: "lotto-screen" },
  ];

  function setActiveScreen(screenId) {
    // nav active
    for (const s of screens) {
      const btn = $(s.nav);
      if (btn) btn.classList.toggle("active", s.screen === screenId);
    }
    // screen active
    for (const s of screens) {
      const el = $(s.screen);
      if (el) el.classList.toggle("screen-active", s.screen === screenId);
    }
  }

  // -----------------------
  // CoinGecko price (MON/USD)
  // Using CoinGecko coin id: "monad"
  // -----------------------
  async function fetchMonUsd() {
    try {
      const url =
        "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd";
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const p = j?.monad?.usd;
      if (typeof p !== "number") throw new Error("Invalid price response");
      return p;
    } catch (e) {
      return null;
    }
  }

  async function updateVinUsdChip() {
    const chip = $("vinUsdChip");
    if (!chip) return;
    safeText(chip, "Loading...");
    const monUsd = await fetchMonUsd();
    if (monUsd === null) {
      safeText(chip, "-");
      return;
    }
    const vinUsd = monUsd * MON_PER_VIN; // ×100
    safeText(chip, `$${fmtFixed(vinUsd, 6)}`);
  }

  // -----------------------
  // Wallet / chain
  // -----------------------
  function hasEthereum() {
    return typeof window !== "undefined" && window.ethereum;
  }

  async function ensureMonadNetwork() {
    if (!hasEthereum()) throw new Error("No wallet found.");
    const eth = window.ethereum;

    const currentChainId = await eth.request({ method: "eth_chainId" });
    if (currentChainId === CHAIN_ID_HEX) return;

    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (err) {
      // If the chain has not been added to MetaMask
      if (err && (err.code === 4902 || (err.data && err.data.originalError?.code === 4902))) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_ID_HEX,
              chainName: CHAIN_NAME,
              rpcUrls: [RPC_URL],
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              blockExplorerUrls: [EXPLORER],
            },
          ],
        });
      } else {
        throw err;
      }
    }
  }

  async function connect() {
    if (!hasEthereum()) {
      alert("MetaMask not found.");
      return;
    }

    try {
      await ensureMonadNetwork();

      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      await provider.send("eth_requestAccounts", []);
      signer = provider.getSigner();
      user = await signer.getAddress();

      vin = new ethers.Contract(ADDR.VIN, ERC20_ABI, signer);
      swap = new ethers.Contract(ADDR.SWAP, SWAP_ABI, signer);
      dice = new ethers.Contract(ADDR.DICE, DICE_ABI, signer);
      lotto = new ethers.Contract(ADDR.LOTTO, LOTTO_ABI, signer);

      // Decimals (VIN)
      try {
        vinDecimals = await vin.decimals();
      } catch (_) {
        vinDecimals = 18;
      }

      // Dice limits
      await loadDiceLimits();
      await loadLottoLimits();

      safeText($("connectBtn"), shortAddr(user));
      setConnectedDot(true);

      // Fill wallet short fields
      safeText($("homeWalletShort"), shortAddr(user));
      safeText($("swapWalletShort"), shortAddr(user));
      safeText($("diceWalletShort"), shortAddr(user));
      safeText($("lottoWalletShort"), shortAddr(user));

      await refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Connect failed.");
    }
  }

  function setupWalletListeners() {
    if (!hasEthereum()) return;
    const eth = window.ethereum;

    eth.on("accountsChanged", async (accounts) => {
      if (!accounts || accounts.length === 0) {
        provider = null;
        signer = null;
        user = null;
        vin = swap = dice = lotto = null;
        safeText($("connectBtn"), "Connect");
        setConnectedDot(false);
        clearBalances();
        return;
      }
      // reconnect quickly
      await connect();
    });

    eth.on("chainChanged", async () => {
      // MetaMask recommends reloading on chain change
      window.location.reload();
    });
  }

  // -----------------------
  // Load contract constants
  // -----------------------
  async function loadDiceLimits() {
    if (!dice) return;
    try {
      const minBN = await dice.MIN_BET();
      const maxBN = await dice.MAX_BET();
      DICE_MIN = Number(ethers.utils.formatUnits(minBN, vinDecimals));
      DICE_MAX = Number(ethers.utils.formatUnits(maxBN, vinDecimals));
      safeText($("diceMinValue"), fmt(DICE_MIN, 6));
      safeText($("diceMaxValue"), fmt(DICE_MAX, 6));
      safeText($("diceMinLine"), `MIN: ${fmt(DICE_MIN, 6)} VIN • MAX: ${fmt(DICE_MAX, 6)} VIN`);
    } catch (e) {
      // fallback
      DICE_MIN = 1;
      DICE_MAX = 50;
      safeText($("diceMinValue"), "1");
      safeText($("diceMaxValue"), "50");
      safeText($("diceMinLine"), `MIN: 1 VIN • MAX: 50 VIN`);
    }
  }

  async function loadLottoLimits() {
    if (!lotto) return;
    try {
      const minBN = await lotto.MIN_BET();
      LOTTO_MIN = Number(ethers.utils.formatUnits(minBN, vinDecimals));
      safeText($("lottoMinLine"), `MIN: ${fmt(LOTTO_MIN, 6)} VIN`);
    } catch (_) {
      LOTTO_MIN = 1;
      safeText($("lottoMinLine"), "MIN: 1 VIN");
    }

    try {
      const d = await lotto.REVEAL_DELAY();
      LOTTO_REVEAL_DELAY = Number(d.toString());
    } catch (_) {
      LOTTO_REVEAL_DELAY = 0;
    }
  }

  // -----------------------
  // Refresh balances / allowances / pools
  // -----------------------
  function clearBalances() {
    const ids = [
      "homeVinBalance",
      "homeMonBalance",
      "homeDicePool",
      "homeLottoPool",
      "swapFromBalance",
      "swapToBalance",
      "swapVinBalance",
      "swapMonBalance",
      "diceVinBalance",
      "diceMonBalance",
      "diceAllowance",
      "diceBankroll",
      "lottoVinBalance",
      "lottoAllowance",
      "lottoPool",
    ];
    for (const id of ids) safeText($(id), "-");
  }

  async function refreshAll() {
    await Promise.allSettled([
      updateVinUsdChip(),
      refreshBalances(),
      refreshPools(),
      refreshAllowances(),
      updateSwapUI(), // keep computed fields correct
      updateLottoCommitLabel(),
    ]);
  }

  async function refreshBalances() {
    if (!provider || !vin || !user) return;

    const [monBN, vinBN] = await Promise.all([
      provider.getBalance(user),
      vin.balanceOf(user),
    ]);

    const mon = Number(ethers.utils.formatEther(monBN));
    const vinBal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));

    // Home
    safeText($("homeMonBalance"), `${fmt(mon, 4)} MON`);
    safeText($("homeVinBalance"), `${fmt(vinBal, 4)} VIN`);

    // Swap side card
    safeText($("swapMonBalance"), `${fmt(mon, 4)} MON`);
    safeText($("swapVinBalance"), `${fmt(vinBal, 4)} VIN`);

    // Dice
    safeText($("diceMonBalance"), `${fmt(mon, 4)} MON`);
    safeText($("diceVinBalance"), `${fmt(vinBal, 4)} VIN`);

    // Lotto
    safeText($("lottoVinBalance"), `Balance: ${fmt(vinBal, 4)} VIN`);
  }

  async function refreshPools() {
    if (!vin || !provider) return;

    try {
      const dicePoolBN = await vin.balanceOf(ADDR.DICE);
      const dicePool = Number(ethers.utils.formatUnits(dicePoolBN, vinDecimals));
      safeText($("homeDicePool"), `${fmt(dicePool, 4)} VIN`);
      safeText($("diceBankroll"), `${fmt(dicePool, 4)} VIN`);
    } catch (_) {
      safeText($("homeDicePool"), "-");
      safeText($("diceBankroll"), "-");
    }

    try {
      const lottoPoolBN = await vin.balanceOf(ADDR.LOTTO);
      const lottoPool = Number(ethers.utils.formatUnits(lottoPoolBN, vinDecimals));
      safeText($("homeLottoPool"), `${fmt(lottoPool, 4)} VIN`);
      safeText($("lottoPool"), `${fmt(lottoPool, 4)} VIN`);
    } catch (_) {
      safeText($("homeLottoPool"), "-");
      safeText($("lottoPool"), "-");
    }
  }

  async function refreshAllowances() {
    if (!vin || !user) return;

    // Dice allowance
    try {
      const a = await vin.allowance(user, ADDR.DICE);
      const af = Number(ethers.utils.formatUnits(a, vinDecimals));
      safeText($("diceAllowance"), `${fmt(af, 4)} VIN`);
    } catch (_) {
      safeText($("diceAllowance"), "-");
    }

    // Lotto allowance
    try {
      const a = await vin.allowance(user, ADDR.LOTTO);
      const af = Number(ethers.utils.formatUnits(a, vinDecimals));
      safeText($("lottoAllowance"), `${fmt(af, 4)} VIN`);
    } catch (_) {
      safeText($("lottoAllowance"), "-");
    }
  }

  // -----------------------
  // Swap logic
  // -----------------------
  function setSwapDirection(vinToMon) {
    isVinToMon = vinToMon;

    const t1 = $("tabVinToMon");
    const t2 = $("tabMonToVin");
    if (t1) t1.classList.toggle("active", isVinToMon);
    if (t2) t2.classList.toggle("active", !isVinToMon);

    // token tags
    safeText($("swapFromToken"), isVinToMon ? "VIN" : "MON");
    safeText($("swapToToken"), isVinToMon ? "MON" : "VIN");

    // clear amounts
    const fromEl = $("swapFromAmount");
    const toEl = $("swapToAmount");
    if (fromEl) fromEl.value = "";
    if (toEl) toEl.value = "";

    updateSwapUI();
    refreshBalances().catch(() => {});
  }

  async function updateSwapUI() {
    // balances labels
    if (!provider || !vin || !user) {
      safeText($("swapFromBalance"), "Balance: -");
      safeText($("swapToBalance"), "Balance: -");
      safeText($("swapRateLabel"), "Rate: -");
      return;
    }

    try {
      const [monBN, vinBN] = await Promise.all([
        provider.getBalance(user),
        vin.balanceOf(user),
      ]);

      const mon = Number(ethers.utils.formatEther(monBN));
      const vinBal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));

      if (isVinToMon) {
        safeText($("swapFromBalance"), `Balance: ${fmt(vinBal, 4)} VIN`);
        safeText($("swapToBalance"), `Balance: ${fmt(mon, 4)} MON`);
        safeText($("swapRateLabel"), `Rate: 1 VIN ≈ ${fmt(MON_PER_VIN, 4)} MON`);
      } else {
        safeText($("swapFromBalance"), `Balance: ${fmt(mon, 4)} MON`);
        safeText($("swapToBalance"), `Balance: ${fmt(vinBal, 4)} VIN`);
        safeText($("swapRateLabel"), `Rate: 1 MON ≈ ${fmt(VIN_PER_MON, 6)} VIN`);
      }

      // compute "To" based on input
      const from = toNum($("swapFromAmount")?.value);
      if (from === null) {
        if ($("swapToAmount")) $("swapToAmount").value = "";
        return;
      }

      const out = isVinToMon ? from * MON_PER_VIN : from * VIN_PER_MON;
      if ($("swapToAmount")) $("swapToAmount").value = fmtFixed(out, 6);
    } catch (e) {
      safeText($("swapRateLabel"), "Rate: -");
    }
  }

  async function swapMax() {
    if (!provider || !vin || !user) return;
    try {
      if (isVinToMon) {
        const vinBN = await vin.balanceOf(user);
        const vinBal = Number(ethers.utils.formatUnits(vinBN, vinDecimals));
        $("swapFromAmount").value = fmtFixed(vinBal, 6);
      } else {
        const monBN = await provider.getBalance(user);
        // keep some dust for gas
        let mon = Number(ethers.utils.formatEther(monBN));
        mon = Math.max(0, mon - 0.001);
        $("swapFromAmount").value = fmtFixed(mon, 6);
      }
      await updateSwapUI();
    } catch (_) {}
  }

  async function doSwap() {
    if (!swap || !vin || !user) {
      alert("Connect wallet first.");
      return;
    }

    const statusEl = $("swapStatus");
    const amt = toNum($("swapFromAmount")?.value);
    if (amt === null || amt <= 0) {
      safeText(statusEl, "Enter an amount.");
      return;
    }

    try {
      safeText(statusEl, "Preparing transaction...");

      if (isVinToMon) {
        // Approve if needed
        const amountBN = ethers.utils.parseUnits(String(amt), vinDecimals);
        const allowanceBN = await vin.allowance(user, ADDR.SWAP);

        if (allowanceBN.lt(amountBN)) {
          safeText(statusEl, "Approving VIN...");
          const txA = await vin.approve(ADDR.SWAP, ethers.constants.MaxUint256);
          await txA.wait();
        }

        safeText(statusEl, "Swapping VIN → MON...");
        const est = await swap.estimateGas.swapVINtoMON(amountBN);
        const gasLimit = est.mul(120).div(100);
        const tx = await swap.swapVINtoMON(amountBN, { gasLimit });
        safeText(statusEl, "Transaction sent...");
        await tx.wait();
        safeText(statusEl, "Swap complete.");
      } else {
        const valueBN = ethers.utils.parseEther(String(amt));
        safeText(statusEl, "Swapping MON → VIN...");
        const est = await swap.estimateGas.swapMONtoVIN({ value: valueBN });
        const gasLimit = est.mul(120).div(100);
        const tx = await swap.swapMONtoVIN({ value: valueBN, gasLimit });
        safeText(statusEl, "Transaction sent...");
        await tx.wait();
        safeText(statusEl, "Swap complete.");
      }

      await refreshAll();
    } catch (e) {
      console.error(e);
      safeText(statusEl, extractReason(e) || "Swap failed.");
    }
  }

  // -----------------------
  // Dice logic
  // -----------------------
  let diceChoice = 0; // 0 EVEN, 1 ODD

  function setDiceChoice(choice) {
    diceChoice = choice;
    const evenBtn = $("guessEven");
    const oddBtn = $("guessOdd");
    if (evenBtn) evenBtn.classList.toggle("active", choice === 0);
    if (oddBtn) oddBtn.classList.toggle("active", choice === 1);
  }

  async function diceApprove() {
    if (!vin || !user) {
      alert("Connect wallet first.");
      return;
    }
    const statusEl = $("diceStatus");
    try {
      safeText(statusEl, "Approving VIN...");
      const tx = await vin.approve(ADDR.DICE, ethers.constants.MaxUint256);
      await tx.wait();
      safeText(statusEl, "Approved.");
      await refreshAllowances();
    } catch (e) {
      console.error(e);
      safeText(statusEl, extractReason(e) || "Approve failed.");
    }
  }

  async function diceMax() {
    if (!vin || !user) return;
    try {
      const balBN = await vin.balanceOf(user);
      const bal = Number(ethers.utils.formatUnits(balBN, vinDecimals));
      const max = Math.min(bal, DICE_MAX);
      $("diceBetAmount").value = fmtFixed(max, 6);
    } catch (_) {}
  }

  function randomClientSeed() {
    // uint256 from random bytes
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    let hex = "0x";
    for (const x of b) hex += x.toString(16).padStart(2, "0");
    return ethers.BigNumber.from(hex).toString();
  }

  function setCoins(pattern) {
    const coins = document.querySelectorAll(".dice-coin");
    if (!coins || coins.length === 0) return;

    pattern.forEach((c, i) => {
      const el = coins[i];
      if (!el) return;
      el.classList.remove("dice-coin-white", "dice-coin-red");
      el.classList.add(c === "red" ? "dice-coin-red" : "dice-coin-white");
    });
  }

  function visualizeByResult(isEven) {
    // Even: 3 patterns. Odd: 2 patterns.
    const evenPatterns = [
      ["white", "white", "white", "white"],
      ["red", "red", "red", "red"],
      ["white", "white", "red", "red"],
    ];
    const oddPatterns = [
      ["red", "white", "red", "red"],
      ["red", "red", "red", "white"],
    ];
    const arr = isEven ? evenPatterns : oddPatterns;
    const pick = arr[Math.floor(Math.random() * arr.length)];
    setCoins(pick);
  }

  async function dicePlay() {
    if (!dice || !vin || !user) {
      alert("Connect wallet first.");
      return;
    }

    const statusEl = $("diceStatus");
    const resultText = $("diceResultText");

    const amt = toNum($("diceBetAmount")?.value);
    if (amt === null || amt <= 0) {
      safeText(statusEl, "Enter a bet amount.");
      return;
    }
    if (amt < DICE_MIN || amt > DICE_MAX) {
      safeText(statusEl, `Bet must be between ${fmt(DICE_MIN, 6)} and ${fmt(DICE_MAX, 6)} VIN.`);
      return;
    }

    try {
      safeText(statusEl, "Checking allowance...");
      const amountBN = ethers.utils.parseUnits(String(amt), vinDecimals);
      const allowanceBN = await vin.allowance(user, ADDR.DICE);

      if (allowanceBN.lt(amountBN)) {
        safeText(statusEl, "Approval required. Click Approve VIN first.");
        return;
      }

      const seed = randomClientSeed();
      safeText(statusEl, "Sending transaction...");
      safeText(resultText, "-");

      const est = await dice.estimateGas.play(amountBN, diceChoice, seed);
      const gasLimit = est.mul(120).div(100);

      const tx = await dice.play(amountBN, diceChoice, seed, { gasLimit });
      safeText(statusEl, "Transaction sent...");
      const rc = await tx.wait();

      // Parse Played event (diceResult: 0 even, 1 odd)
      let played = null;
      try {
        for (const log of rc.logs) {
          try {
            const parsed = dice.interface.parseLog(log);
            if (parsed && parsed.name === "Played") {
              played = parsed.args;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}

      if (played) {
        const diceResult = Number(played.diceResult);
        const roll = Number(played.roll);
        const won = Boolean(played.won);

        const isEven = diceResult === 0;
        visualizeByResult(isEven);

        safeText(
          resultText,
          `Result: ${isEven ? "EVEN" : "ODD"} • Roll: ${roll} • ${won ? "WIN" : "LOSE"}`
        );
        safeText(statusEl, "Done.");
      } else {
        // fallback visualization based on choice (still looks good)
        visualizeByResult(diceChoice === 0);
        safeText(resultText, "Done.");
        safeText(statusEl, "Done.");
      }

      await refreshAll();
    } catch (e) {
      console.error(e);
      safeText(statusEl, extractReason(e) || "Dice failed.");
    }
  }

  // -----------------------
  // Lotto logic
  // -----------------------
  function setLottoMode(b27) {
    isBet27 = b27;

    const t1 = $("tabBetOne");
    const t2 = $("tabBet27");
    if (t1) t1.classList.toggle("active", !isBet27);
    if (t2) t2.classList.toggle("active", isBet27);

    // update placeholder hint
    safeText($("lottoPickHint"), isBet27 ? "27 numbers (00–99)" : "e.g. 12,27,45");

    // auto quick generate for convenience
    lottoQuick();
    updateLottoCommitLabel();
  }

  function parseNumbers(input) {
    const s = (input || "").trim();
    if (!s) return [];
    const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
    const nums = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 99) return null;
      nums.push(n);
    }
    return nums;
  }

  function randomInt(max) {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return b[0] % max;
  }

  function lottoQuick() {
    const n = isBet27 ? 27 : 3;
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(String(randomInt(100)).padStart(2, "0"));
    if ($("lottoNumbers")) $("lottoNumbers").value = arr.join(",");
    updateLottoCommitLabel();
  }

  function genSecret() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    let hex = "0x";
    for (const x of b) hex += x.toString(16).padStart(2, "0");
    if ($("lottoSecret")) $("lottoSecret").value = hex;
    updateLottoCommitLabel();
  }

  function normalizeBytes32(hex) {
    const s = (hex || "").trim();
    if (!s) return null;
    try {
      // Ensure it's bytes32
      const padded = ethers.utils.hexZeroPad(s, 32);
      return padded;
    } catch (_) {
      return null;
    }
  }

  function computeCommit(secretBytes32) {
    // Contract checks: keccak256(abi.encodePacked(secret)) == commit
    // For bytes32 secret, this is keccak256(secretBytes32)
    return ethers.utils.keccak256(secretBytes32);
  }

  function updateLottoCommitLabel() {
    const label = $("lottoCommitLabel");
    if (!label) return;
    const s = normalizeBytes32($("lottoSecret")?.value || "");
    if (!s) {
      safeText(label, "Commit: -");
      return;
    }
    const c = computeCommit(s);
    safeText(label, `Commit: ${c.slice(0, 10)}...${c.slice(-8)}`);
  }

  async function lottoApprove() {
    if (!vin || !user) {
      alert("Connect wallet first.");
      return;
    }
    const statusEl = $("lottoStatus");
    try {
      safeText(statusEl, "Approving VIN...");
      const tx = await vin.approve(ADDR.LOTTO, ethers.constants.MaxUint256);
      await tx.wait();
      safeText(statusEl, "Approved.");
      await refreshAllowances();
    } catch (e) {
      console.error(e);
      safeText(statusEl, extractReason(e) || "Approve failed.");
    }
  }

  async function lottoPlaceBet() {
    if (!lotto || !vin || !user) {
      alert("Connect wallet first.");
      return;
    }
    const statusEl = $("lottoStatus");

    const amt = toNum($("lottoAmount")?.value);
    if (amt === null || amt <= 0) {
      safeText(statusEl, "Enter an amount.");
      return;
    }
    if (amt < LOTTO_MIN) {
      safeText(statusEl, `Amount must be >= ${fmt(LOTTO_MIN, 6)} VIN.`);
      return;
    }

    const numbers = parseNumbers($("lottoNumbers")?.value || "");
    if (numbers === null || numbers.length === 0) {
      safeText(statusEl, "Invalid numbers. Use comma-separated 00–99.");
      return;
    }

    const secret = normalizeBytes32($("lottoSecret")?.value || "");
    if (!secret) {
      safeText(statusEl, "Invalid secret. Click Generate.");
      return;
    }

    try {
      safeText(statusEl, "Checking allowance...");
      const amountBN = ethers.utils.parseUnits(String(amt), vinDecimals);
      const allowanceBN = await vin.allowance(user, ADDR.LOTTO);
      if (allowanceBN.lt(amountBN)) {
        safeText(statusEl, "Approval required. Click Approve VIN first.");
        return;
      }

      const commit = computeCommit(secret);
      safeText(statusEl, "Sending transaction...");

      const est = await lotto.estimateGas.placeBet(amountBN, numbers, commit, isBet27);
      const gasLimit = est.mul(120).div(100);

      const tx = await lotto.placeBet(amountBN, numbers, commit, isBet27, { gasLimit });
      safeText(statusEl, "Transaction sent...");
      await tx.wait();

      safeText(statusEl, "Bet placed. Keep your secret for reveal.");
      await refreshAll();
    } catch (e) {
      console.error(e);
      safeText(statusEl, extractReason(e) || "Place bet failed.");
    }
  }

  async function lottoReveal() {
    if (!lotto || !user) {
      alert("Connect wallet first.");
      return;
    }
    const statusEl = $("lottoStatus");

    const secret = normalizeBytes32($("lottoSecret")?.value || "");
    if (!secret) {
      safeText(statusEl, "Invalid secret. Paste the same secret used for commit.");
      return;
    }

    try {
      safeText(statusEl, "Sending transaction...");

      const est = await lotto.estimateGas.reveal(secret);
      const gasLimit = est.mul(120).div(100);

      const tx = await lotto.reveal(secret, { gasLimit });
      safeText(statusEl, "Transaction sent...");
      await tx.wait();

      safeText(
        statusEl,
        LOTTO_REVEAL_DELAY > 0
          ? "Reveal done."
          : "Reveal done."
      );
      await refreshAll();
    } catch (e) {
      console.error(e);
      const r = extractReason(e);
      if (r && r.includes("TOO_EARLY") && LOTTO_REVEAL_DELAY > 0) {
        safeText(statusEl, `Too early. Wait at least ${LOTTO_REVEAL_DELAY} blocks.`);
      } else {
        safeText(statusEl, r || "Reveal failed.");
      }
    }
  }

  // -----------------------
  // Common errors
  // -----------------------
  function extractReason(e) {
    try {
      const msg = e?.error?.message || e?.data?.message || e?.message || "";
      // Common revert formats
      const m1 = msg.match(/reverted with reason string '([^']+)'/);
      if (m1) return m1[1];
      const m2 = msg.match(/execution reverted: ([^"]+)/);
      if (m2) return m2[1];
      const m3 = msg.match(/VM Exception while processing transaction: revert ([^"]+)/);
      if (m3) return m3[1];
      // Some providers embed "reason"
      if (e?.error?.reason) return e.error.reason;
      if (e?.reason) return e.reason;
      return msg || null;
    } catch (_) {
      return null;
    }
  }

  // -----------------------
  // Wire UI
  // -----------------------
  function wireNav() {
    $("navHome")?.addEventListener("click", () => setActiveScreen("home-screen"));
    $("navSwap")?.addEventListener("click", () => setActiveScreen("swap-screen"));
    $("navDice")?.addEventListener("click", () => setActiveScreen("dice-screen"));
    $("navLotto")?.addEventListener("click", () => setActiveScreen("lotto-screen"));

    $("goSwapBtn")?.addEventListener("click", () => setActiveScreen("swap-screen"));
    $("goDiceBtn")?.addEventListener("click", () => setActiveScreen("dice-screen"));
    $("goLottoBtn")?.addEventListener("click", () => setActiveScreen("lotto-screen"));
  }

  function wireButtons() {
    $("connectBtn")?.addEventListener("click", connect);
    $("refreshBtn")?.addEventListener("click", refreshAll);

    // Swap
    $("tabVinToMon")?.addEventListener("click", () => setSwapDirection(true));
    $("tabMonToVin")?.addEventListener("click", () => setSwapDirection(false));
    $("swapFromAmount")?.addEventListener("input", updateSwapUI);
    $("swapMaxBtn")?.addEventListener("click", swapMax);
    $("swapBtn")?.addEventListener("click", doSwap);

    // Dice
    $("guessEven")?.addEventListener("click", () => setDiceChoice(0));
    $("guessOdd")?.addEventListener("click", () => setDiceChoice(1));
    $("diceApproveBtn")?.addEventListener("click", diceApprove);
    $("dicePlayBtn")?.addEventListener("click", dicePlay);
    $("diceMaxBtn")?.addEventListener("click", diceMax);

    // Lotto
    $("tabBetOne")?.addEventListener("click", () => setLottoMode(false));
    $("tabBet27")?.addEventListener("click", () => setLottoMode(true));
    $("lottoQuickBtn")?.addEventListener("click", lottoQuick);
    $("lottoGenSecretBtn")?.addEventListener("click", genSecret);
    $("lottoSecret")?.addEventListener("input", updateLottoCommitLabel);
    $("lottoApproveBtn")?.addEventListener("click", lottoApprove);
    $("lottoPlaceBetBtn")?.addEventListener("click", lottoPlaceBet);
    $("lottoRevealBtn")?.addEventListener("click", lottoReveal);
    $("lottoNumbers")?.addEventListener("input", updateLottoCommitLabel);
  }

  // -----------------------
  // Init
  // -----------------------
  async function init() {
    wireNav();
    wireButtons();
    setupWalletListeners();

    setConnectedDot(false);
    setActiveScreen("home-screen");
    setSwapDirection(true);
    setDiceChoice(0);
    setLottoMode(false);

    // Price chip can load without wallet
    await updateVinUsdChip();

    // Auto refresh price every 30s
    setInterval(() => {
      updateVinUsdChip().catch(() => {});
    }, 30000);
  }

  window.addEventListener("DOMContentLoaded", init);
})();
