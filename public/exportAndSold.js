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

	const journals = [];
	journals.push(...(await getCharacterWalletJournals(SELLER_CHARACTER_ID, SELLER_ACCESS_TOKEN)));

	const typeIds = [...(new Set(transactions.map(tx => tx.type_id)))];

	outputElem.innerHTML = `Processing`;

	const amountByRefType = {};
	for (let j of journals) {
		const internalDonationRegex = new RegExp(`[^ ]+ Isk deposited cash into [^ ]+ Isk's account`);
		if (internalDonationRegex.test(j.description)) {
			// isk holder changed but no isk was really spent/received so ignore
			continue;
		}
		if (j.ref_type === 'market_escrow') {
			// cancels with itself in the long run so ignore
			continue;
		}
		amountByRefType[j.ref_type] = amountByRefType[j.ref_type] || 0;
		amountByRefType[j.ref_type] += j.amount;
	}
	
	const contractItemFlows = (amountByRefType['contract_price'] || 0);
	const contractHaulFlows = ['contract_reward_refund', 'contract_reward_deposited', 'player_donation']
		.reduce((acc, refType) => acc + (amountByRefType[refType] || 0), 0);
	const contractFeeFlows = ['contract_brokers_fee', 'contract_deposit', 'contract_deposit_refund']
		.reduce((acc, refType) => acc + (amountByRefType[refType] || 0), 0);
	const contractFlows = contractItemFlows + contractHaulFlows + contractFeeFlows;
	const marketSalesTaxFlows = (amountByRefType['transaction_tax'] || 0);
	const marketBrokerFeeFlows = (amountByRefType['brokers_fee'] || 0);
	const marketRevenueFlows = (amountByRefType['market_transaction'] || 0);
	const totalFlows = marketRevenueFlows + marketSalesTaxFlows + marketBrokerFeeFlows + contractFlows;

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
		// const unreferencedJournals = journals.filter(j => !journalRefIds.includes(j.id));
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
	html += (Math.floor(summedTotalProfitMil*100)/100) + '<br/>';
	html += `${roundMils(totalFlows)} = ${roundMils(marketRevenueFlows)} - ${roundMils(-1*contractFlows)} - ${roundMils(-1*marketSalesTaxFlows)} (tax) - ${roundMils(-1*marketBrokerFeeFlows)} (broker)` + '<br/>';
	outputElem.innerHTML = html;
});
