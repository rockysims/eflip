const BUYER_ACCESS_TOKEN = IVAN_ACCESS_TOKEN;
const SELLER_ACCESS_TOKEN = GRANT_ACCESS_TOKEN;
const BUYER_CHARACTER_ID = IVAN_CHARACTER_ID;
const SELLER_CHARACTER_ID = GRANT_CHARACTER_ID;

const {
	getCharacterWalletTransactions,
	getCharacterWalletJournals,
	getTypeName,
	roundMils,
	avg
} = util;

const getItemExportAndSoldReport = async (transactions) => {
	try {
		const buyTransactions = transactions.filter(tx => tx.is_buy);
		const sellTransactions = transactions.filter(tx => !tx.is_buy);
		const avgCost = avg(buyTransactions.map(tx => tx.unit_price));
		const avgRevenue = avg(sellTransactions.map(tx => tx.unit_price));
		const sold = sellTransactions.map(sellTx => sellTx.quantity).reduce((acc, cur) => acc + cur, 0);
		
		return {
			avgCostMil: roundMils(avgCost),
			avgRevenueMil: roundMils(avgRevenue),
			avgProfitMil: roundMils(avgRevenue - avgCost),
			totalProfitMil: roundMils(sold * (avgRevenue - avgCost)),
			sold
		};
	} catch (reason) {
		console.warn(reason);
		return null;
	}
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('#outputDiv');

	outputElem.innerHTML = 'Starting...';

	const journals = [];
	journals.push(...(await getCharacterWalletJournals(BUYER_CHARACTER_ID, BUYER_ACCESS_TOKEN)));
	if (BUYER_CHARACTER_ID !== SELLER_CHARACTER_ID){
		journals.push(...(await getCharacterWalletJournals(SELLER_CHARACTER_ID, SELLER_ACCESS_TOKEN)));
	}
	console.log({journals})
	

	const transactions = [];
	transactions.push(...(await getCharacterWalletTransactions(BUYER_CHARACTER_ID, BUYER_ACCESS_TOKEN)));
	if (BUYER_CHARACTER_ID !== SELLER_CHARACTER_ID){
		transactions.push(...(await getCharacterWalletTransactions(SELLER_CHARACTER_ID, SELLER_ACCESS_TOKEN)));
	}
	const typeIds = [...(new Set(transactions.map(tx => tx.type_id)))];

	outputElem.innerHTML = `Processing`;

	const itemReportByTypeId = {};
	const promises = [];
	for (let typeId of typeIds) {
		const transactionsOfType = transactions.filter(tx => tx.type_id === typeId);
		const reportPromise = getItemExportAndSoldReport(transactionsOfType);
		reportPromise.then(itemReport => itemReportByTypeId[typeId] = itemReport);
		promises.push(reportPromise);
	}
	await Promise.all(promises);

	outputElem.innerHTML = `Sorting`;

	const typeIdsOrderedByProfitDesc = typeIds.sort((a, b) => {
		const aRep = itemReportByTypeId[a];
		const bRep = itemReportByTypeId[b];
		return (bRep?.totalProfitMil || 0) - (aRep?.totalProfitMil || 0);
	});

	outputElem.innerHTML = `Ready`;

	let html = '';
	let summedTotalProfitMil = 0;
	for (let typeId of typeIdsOrderedByProfitDesc) {
		const itemReport = itemReportByTypeId[typeId];
		if (!itemReport) continue;

		if (isNaN(itemReport.avgProfitMil)) continue;
		
		const typeName = await getTypeName(typeId);

		const itemReportStr = Object.entries(itemReport).map(([key, val]) => key + ': ' + val).join(' &nbsp; ');

		summedTotalProfitMil += 1*itemReport.totalProfitMil;

		html += '<div class="item">';
		html += 	'<div>';
		html += 		`${itemReport.totalProfitMil} (${itemReport.avgProfitMil} * ${itemReport.sold}) &nbsp; ${typeName} (${typeId})`;
		html +=			' &nbsp; ';
		html += 		'<span class="dim">';
		html += 			itemReportStr;
		html += 		'</span>';	
		html += 	'</div>';
		html += '</div>';	
	}
	html += '<hr/>';
	html += summedTotalProfitMil;
	outputElem.innerHTML = html;
});
