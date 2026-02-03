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



		//TODO: consider journal entries to adjust for broker fees and sales tax (and relisting fees)
		// tx.journal_ref_id <-> j.id (for sales tax)
		// ? (for broker fee) j.ref_type === "brokers_fee"
		// ? (for broker fee when changing price if different)

		// console.log({transactions, avgCost, avgRevenue})
		// const sellJournals = journals.filter(j => j.)
		


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

	const transactions = [];
	transactions.push(...(await getCharacterWalletTransactions(BUYER_CHARACTER_ID, BUYER_ACCESS_TOKEN)));
	if (BUYER_CHARACTER_ID !== SELLER_CHARACTER_ID){
		transactions.push(...(await getCharacterWalletTransactions(SELLER_CHARACTER_ID, SELLER_ACCESS_TOKEN)));
	}

	// const journals = [];
	// journals.push(...(await getCharacterWalletJournals(BUYER_CHARACTER_ID, BUYER_ACCESS_TOKEN)));
	// if (BUYER_CHARACTER_ID !== SELLER_CHARACTER_ID){
	// 	journals.push(...(await getCharacterWalletJournals(SELLER_CHARACTER_ID, SELLER_ACCESS_TOKEN)));
	// }

	const typeIds = [...(new Set(transactions.map(tx => tx.type_id)))];

	outputElem.innerHTML = `Processing`;

	const itemReportByTypeId = {};
	const promises = [];
	for (let typeId of typeIds) {
		const transactionsOfType = transactions.filter(tx => tx.type_id === typeId);
		// const journalRefIds = transactionsOfType.map(tx => tx.journal_ref_id);
		const hydratedTransactionsOfType = transactionsOfType.map(tx => ({
			...tx,
			// journals: journals.filter(j => journalRefIds.includes(j.id))
		}));
		// const journalRefIds = transactionsOfType.map(tx => tx.journal_ref_id);
		// const referencedJournals = journals.filter(j => journalRefIds.includes(j.id));
		// console.log({
		// 	journalsOfType: referencedJournals,
		// 	journals
		// })
		const reportPromise = getItemExportAndSoldReport(hydratedTransactionsOfType);
		reportPromise.then(itemReport => itemReportByTypeId[typeId] = itemReport);
		promises.push(reportPromise);
	}
	await Promise.all(promises);

	outputElem.innerHTML = `Sorting`;

	const typeIdsOrderedByProfitDesc = typeIds
		.filter(typeId => !isNaN(itemReportByTypeId[typeId].totalProfitMil))	
		.sort((a, b) => {
			const aRep = itemReportByTypeId[a];
			const bRep = itemReportByTypeId[b];
			return bRep.totalProfitMil - aRep.totalProfitMil;
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
