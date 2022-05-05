const axios = require("axios");
const fs = require("fs");
const CoinGecko = require("coingecko-api");

const TERRA_FCD_URL = "https://fcd.terra.dev";
const TX_CACHE_FILE = "./all-transactions.json";
const SLEEP_TIME_FOR_TX_INDEXING = 700; // milliseconds

const CoinGeckoClient = new CoinGecko();

main();

async function main() {
  const allTransactions = await getAllTransactions();
  const botsMintingReport = prepareBotsMintingReport(allTransactions);
  console.log(botsMintingReport);
  const marketplaceSalesReport = await prepareMarketplaceSalesReport({
    allTransactions,
    botsMintingReport,
  });
  const reportPerCollection = prepareReportPerCollection({
    botsMintingReport,
    marketplaceSalesReport,
  });
  const finalReport = prepareFinalReport({
    botsMintingReport,
    marketplaceSalesReport,
    reportPerCollection,
  });
  
  // Print everything in a user-friendly way
  prettyPrintReports({
    botsMintingReport,
    marketplaceSalesReport,
    reportPerCollection,
    finalReport,
  });
}

// This functions uses file caching to not load txs multiple times
// while developing and testing the script
async function getAllTransactions() {
  if (!fs.existsSync(TX_CACHE_FILE)) {
    const allTransactions = {};
    for (const address of getAllControlledAddresses()) {
      const txsForAddress = await getAllTxsForAddress(address);
      allTransactions[address] = txsForAddress;
    }
    fs.writeFileSync(TX_CACHE_FILE, JSON.stringify(allTransactions, null, 2));
  } else {
    console.log(`Txs cache file located. Loading txs from this file...`);
  }

  return JSON.parse(fs.readFileSync(TX_CACHE_FILE));
}

async function getAllTxsForAddress(address) {
  console.log(`\n\n== Loading all txs for address: ${address} ==`);

  const limit = 100, allTxsForAddress = [];
  let offset, pageNr = 1, finished = false;
  while (!finished) {
    const txsOnPageResponse = await getTxsOnPageForAddress({ address, offset, limit, pageNr });
    allTxsForAddress.push(...txsOnPageResponse.txs);
    if (txsOnPageResponse.txs.length < limit) {
      finished = true;
    } else {
      pageNr++;
      offset = txsOnPageResponse.next;
    }
    await sleep(SLEEP_TIME_FOR_TX_INDEXING);
  }
  return allTxsForAddress;
}

async function getTxsOnPageForAddress({ address, offset, limit, pageNr }) {
  console.log(`Loading txs for address: ${address} on page: ${pageNr}`);
  const response = await axios.get(`${TERRA_FCD_URL}/v1/txs`, {
    params: {
      account: address,
      offset,
      limit,
    },
  });
  return response.data;
}

function prepareBotsMintingReport(allTransactions) {
  const botsMintingReport = {};
  
  for (const botAddress of getBotAddresses()) {
    const botTransactions = allTransactions[botAddress];
    const botMintingReportForAddress = prepareBotMintingReportForAddress(botTransactions);
    botsMintingReport[botAddress] = botMintingReportForAddress;
    console.log({botMintingReportForAddress, botAddress});
  }

  return botsMintingReport;
}

function prepareBotMintingReportForAddress(botTransactions) {
  const botMintingReport = {
    mintedNFTs: {},
    mintedNFTsCount: 0,
    totalUstSpent: 0,
  };

  for (const tx of botTransactions) {
    const isTxSuccessful = tx?.logs?.length > 0;
    const txMsgs = tx.tx?.value?.msg;
    const isSuccessfulMintTx = txMsgs[0]?.value?.execute_msg?.random_mint && isTxSuccessful;

    if (isSuccessfulMintTx) {
      const nftContractAddress = tx.logs[0].events[3].attributes[3].value;
      const collectionName = getNftCollectionNameByContractAddress(nftContractAddress);
      const mintedCountInTx = txMsgs.length;
      const mintedTokenIds = [];
      let ustSpentInTx = 0;

      for (const txMsgLog of tx.logs) {
        const events = txMsgLog.events;
        const mintedTokenId = events[6].attributes[7].value;
        const ustSpentInMsg = getUstAmount(events[0].attributes[1].value);
        mintedTokenIds.push(mintedTokenId);
        ustSpentInTx += ustSpentInMsg;
      }

      // Update the report
      botMintingReport.mintedNFTsCount += mintedCountInTx;
      botMintingReport.totalUstSpent += ustSpentInTx;
      if (botMintingReport.mintedNFTs[collectionName]) {
        botMintingReport.mintedNFTs[collectionName].tokenIds.push(...mintedTokenIds);
        botMintingReport.mintedNFTs[collectionName].mintedCount += mintedCountInTx;
        botMintingReport.mintedNFTs[collectionName].ustSpent += ustSpentInTx;
      } else {
        botMintingReport.mintedNFTs[collectionName] = {
          nftContractAddress,
          tokenIds: [...mintedTokenIds],
          mintedCount: mintedCountInTx,
          ustSpent: ustSpentInTx,
        };
      }
    }
  }

  return botMintingReport;
}

// E.g. for 99200000uusd it will return 99.2
function getUstAmount(ustAmountStr) {
  if (!ustAmountStr.endsWith("uusd")) {
    throw new Error(`Not a valid UST amount string: ${ustAmountStr}`);
  }
  return parseInt(ustAmountStr) / 1000000; // Terra has 6 decimals for UST
}

async function prepareMarketplaceSalesReport({ allTransactions, botsMintingReport }) {
  const marketplaceSalesReport = {};

  for (const address of getAllControlledAddresses()) {
    const salesReportForAddress = await prepareMarketplaceSalesReportForAddress({
      transactions: allTransactions[address],
      botsMintingReport,
    });
    marketplaceSalesReport[address] = salesReportForAddress;
  }

  return marketplaceSalesReport;
}

async function prepareMarketplaceSalesReportForAddress({ transactions, botsMintingReport }) {
  const salesReportForAddress = {
    soldNfts: {},
    soldNftsCount: 0,
    ustEarnedFromSales: 0,
  };

  for (const tx of transactions) {
    const isTxSuccessful = tx?.logs?.length > 0;
    const txMsgs = tx.tx?.value?.msg;
    const isSuccessfulSellTx = isTxSuccessful
      && txMsgs?.length == 2
      && txMsgs[1].value?.execute_msg?.execute_order;

    if (isSuccessfulSellTx) {
      const txAttributes = tx.logs[1].events[6].attributes;

      const nftCollectionAddress = txAttributes[10].value;
      const nftCollectionName = getNftCollectionNameByContractAddress(nftCollectionAddress);
      const denom = txAttributes[7].value; // uluna or uusd
      const earnedAmount = txAttributes[9].value / 1000000; // Both uusd and uluna have 6 decimals

      console.log({earnedAmount, denom});
      const timestamp = new Date(tx.timestamp).getTime();
      const earnedUstValue = await calculateUstValue({
        denom,
        amount: earnedAmount,
        timestamp,
      });
      const soldTokenId = txAttributes[11].value;

      const mintedByBots = wasTokenMintedByBots({
        botsMintingReport,
        tokenId: soldTokenId,
        nftCollectionName,
      });

      if (mintedByBots) {
        salesReportForAddress.ustEarnedFromSales += earnedUstValue;
        salesReportForAddress.soldNftsCount++;
  
        if (!salesReportForAddress.soldNfts[nftCollectionName]) {
          salesReportForAddress.soldNfts[nftCollectionName] = {
            ustEarnedFromSales: earnedUstValue,
            soldNftsCount: 1,
            soldTokenIds: [soldTokenId],
          };
        } else {
          salesReportForAddress.soldNfts[nftCollectionName].ustEarnedFromSales += earnedUstValue;
          salesReportForAddress.soldNfts[nftCollectionName].soldNftsCount++;
          salesReportForAddress.soldNfts[nftCollectionName].soldTokenIds.push(soldTokenId);
        }
      }
    }
  }

  return salesReportForAddress;
}

function wasTokenMintedByBots({ botsMintingReport, tokenId, nftCollectionName }) {
  for (const reportForBot of Object.values(botsMintingReport)) {
    if (reportForBot.mintedNFTs[nftCollectionName]?.tokenIds.includes(tokenId)) {
      return true;
    }
  }
  return false;
}

async function calculateUstValue({ denom, amount, timestamp }) {
  if (denom === "uusd") {
    return amount;
  } else {
    const historicalLunaPrice = await getHistoricalLunaPriceInUSD(timestamp);
    return historicalLunaPrice * amount;
  }
}

// TODO: implement
async function getHistoricalLunaPriceInUSD(timestamp) {
  // return 100;

  // const response = await CoinGeckoClient.coins.fetchMarketChartRange("terra-luna", {
  //   from: timestamp,
  //   to: timestamp,
  // });

  // console.log(response);

  return 100;
}

// TODO: implement
function prepareReportPerCollection({ botsMintingReport, marketplaceSalesReport }) {
  const reportPerCollection = {};

  // for (const botMintingReport)

  return reportPerCollection;
}

function prepareFinalReport({ botsMintingReport, marketplaceSalesReport }) {
  const finalReport = {
    totalUstSpent: 0,
    totalUstEarned: 0,
    totalNftsMinted: 0,
    totalProfitInUST: 0,
    soldNftsCount: 0,
  };
  
  for (const botMintingReport of Object.values(botsMintingReport)) {
    finalReport.totalUstSpent += botMintingReport.totalUstSpent;
    finalReport.totalNftsMinted += botMintingReport.mintedNFTsCount;
  }

  for (const salesReport of Object.values(marketplaceSalesReport)) {
    finalReport.totalUstEarned += salesReport.ustEarnedFromSales;
    finalReport.soldNftsCount += salesReport.soldNftsCount;
  }

  finalReport.totalProfitInUST = finalReport.totalUstEarned - finalReport.totalUstSpent;

  return finalReport;
}

// TODO: improve this function
function prettyPrintReports({
  botsMintingReport,
  marketplaceSalesReport,
  finalReport,
}) {
  console.log(JSON.stringify({
    botsMintingReport,
    marketplaceSalesReport,
    finalReport,
  }, null, 2));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAllControlledAddresses() {
  return [
    ...getOtherControlledAddresses(),
    ...getBotAddresses(),
  ];
}

function getNftCollectionNameByContractAddress(nftContractAddress) {
  const addressToName = {
    "terra1uv9w7aaq6lu2kn0asnvknlcgg2xd5ts57ss7qt": "HellCats",
    "terra1nyqyxamvuhtd8h756tkqsejc7plj6lr5gdfj5e": "LUNI",
    "terra1ggv86dkuzmky7ww20s2uvm6pl2jvl9mv0z6zyt": "DystopAI",
    "terra1cefmm3msvp2erknw54zjlnh39e5lww685nzl50": "Fake Luna Shield",
    "terra1qpu42s4hrrnvxsxr428scd5st9zd4fmn5me38t": "Luna Shield",
    "terra1p4mlfdwm4h0hvyv0c64kmj3afs5zzj3t2jszvw": "COL",
    "terra1h9rhu457nllgrh4w8rcmc2exv6nvfcjdnd30j0": "Silent Solohs",
    "terra1l94ukqc5c3tqjgkvawx5cngf7uq5nz808h6kwf": "TerraBay | Ronins",
    "terra1vdwz6zlrk6ptsxu97dk43uup9frchuwse8s6d8": "ArtsyApes",
    "terra1whyze49j9d0672pleaflk0wfufxrh8l0at2h8q": "Terranauts",
    "terra1k5pa7htlznr7hskhr9dx8qlk65emhktrgmuknd": "Tesseract",
    "terra1chu9s72tqguuzgn0tr6rhwvnrgcgzme73y5l4x": "Skeleton Punks",
    "terra1x8m8vju636xh7026dehq6g7ye66tn0yu4c7mq8": "Rekt Wolf",
    "terra1d8m6k7ww7x0zcedq8gqckn0ez863a75p0ckwla": "Luna Lions",
    "terra1stzp2dlwceqh6k6cffv4zj64ddx28rdgpdal74": "MutantZ",
    "terra1ygy58urzh826al6ktlskh4z6hnd2aunhcn0cvm": "Galactic Gridz",
    "terra1pw0x4f7ktv4vdqvx8dfaa5d2lp0t5rpzep9ewn": "MintDAO NFT",
    "terra1my4sy2gt5suu9fgt8wdkm7ywrd5jzg86692as2": "Anarchists on Terra",
    "terra1alskwhl7x6gteuqkw7z9pexw4v9hr78mh0r6da": "Astro Heroes",
    "terra14aykuyg03462at2tpnua7tnhk7p0dr7wexepnh": "LUNILAND Plots #1",
    "terra1njclu68srjlprwnj80wrs5pyyp2rksecedtypp": "Genesis Wolves",
    "terra13fz4lrx6z952phcjjqzzacavnhxq2u5vt402vj": "LUNITA",
    "terra17hsdmscnz0y24d5zn7k4tsru9clyazp8cwtd44": "GraviCats",
    "terra1qz4ada96pqtxm0pg7gz4ttulv6cj7mjc4vdyl2": "HellHounds",
    "terra1ynr8vav5anknl67nfgnhqvj4dj0wqj7tsaemc6": "Unstables: Aliens of Luna",
  };

  if (!addressToName[nftContractAddress]) {
    throw new Error(`Collection not found: ${nftContractAddress}`);
  }

  return addressToName[nftContractAddress];
}

function getOtherControlledAddresses() {
  return [
    "terra16rtjuzwwvqdwuslevcp09jdxwqqgwpdghdy5sw",
    "terra1em70vvqc9kf9qatzuyr60mgzzwjzz834n599rq",
    "terra1s6kp590lh66kat73zlxg3y3va9990p4mnnxuek",
    "terra1qjz84ygvtn0vcm4g4xnm023m4d8hze50286jh9",
    "terra1mzvfz6zhprchqwluux9zz42x2xua0p8qekxg0z",
    "terra1pwsunmtya0z7kgd59v6eu7q08udnyrrazn3ht5",
    "terra1vqxe3r46vem2y7c0puz6yfhdc2zrhwtzg3ceug",
  ];
}

function getBotAddresses() {
  return [
    "terra1mvd3ca3h6gcljq4ntvakh23kjk3wyhk4z0tu2m",
    "terra1j0mwwkk49r0mml23tek30ueanr93750vpmuswt",
    "terra15a8wa7erj6ajvsswyvxdjfe4dm3nrnh96c6m4u",
    "terra1x9s9qgdsdaxhh3df9kcnqe5dyyzz2q5smragv2",
    "terra1ala6zs487f6trrt504az0syfsttd029xuhnh6q",
    "terra1nucq3q83yhmnnt2uteaykh0kksfu9y65nrvex9",
    "terra1ljnhx8f644c60r6jz628p9k67us4r2kg9s4g7d",
    "terra1jn9eu45fgdxfwmq3y9afdd9x2dmgt45r78lccy",
    "terra12fyk2wrwygg7054js9t3hj6rrn2ccd6z2grshp",
    "terra1xymaerjna07yv7e32u7vfvhs7594wczh6ffflt",
    "terra138xnes8d4835ds6sk4wsf44x583485rv4z4htl",
    "terra1z6tpjlhvhl6dv2djm52vcdkw2amv637s43cpsl",
    "terra1wz6lp9ayf35k8cdxesmyrydxxeglyptxhwg9e8",
    "terra19682etxsay8h4lrff5cg70adh0mmjm3ctamy7n",
    "terra1d3hl5s4ncu6e02u560hjaevq9slffwrswd4g4r",
    "terra1jg3wnmd8fxgdhtmpnwnz6dgxeuvk8a9nxya037",
    "terra1mkmm846a97phqlr9zpu94phjqvwegja66pufh0",
    "terra159zpdxf07yhe7szkmhy9qwqwm7e6m3yljch2qu",
    "terra1v9agdxx8pcsd9734n79f3yg9wh4e3ft2vnlnwv",
    "terra1tyccxuq2kuyn44zxsy8jupednquyq04547w0hh",
    "terra1hgj4ar7a28el4hqgdndkruvl7shemjvjqd2cfr",
    "terra18zvr67rf26q24aclzpkc4ed98usq9sm9wny96d",
    "terra1weh2q3utyhfpt8j36v5yp0nyhcl2r8hu2zkusc",
    "terra1t38xtlz0huywh8h5c74pnzwcntajyn5aajzekn",
    "terra1nwgcam5fxtradcxcmpy3x3nus7g258wtg2f3ze",
    "terra138turxsmh3q462264let7h4pz9dkyk7fvnf0yj",
    "terra1ft3yzexjnl6ryfz4f277k9haus4xykqt0ge3ee",
    "terra1ry0c33tsaqfxd4hdwmx8z2l5awk728cphx8rwj",
    "terra138vryeyjsalhefcv0acf9pjjapfpet096r9n30",
    "terra1vc4c3gjduhptqvfzjr2xml9skwyte7y759j0ey",  
  ];
}
