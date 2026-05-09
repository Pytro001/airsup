export const messages = {
  buyer: {
    signup: () =>
      `Hi, it's Supi, I received your brief and started my research for the best suppliers. When I find someone who matches your requirements, I brief them with your project information and manage the conversation. If you want to add any knowledge or files to your project, you can upload them into this chat, and I will add them to your project.`,

    understandAndConfirm: (summary: string) =>
      `Just to make sure I got this right. ${summary}. Let me know if I missed anything, otherwise I will start researching factories now. First update within 24 hours.`,

    researchStarted: () =>
      `Got it. Researching now. I will be back when I have a match.`,

    supplierFound: (factoryName: string) =>
      `My pick for your project is ${factoryName}. I briefed them with your project information and will be back within 24 hours with their answer.`,

    supplierConfirmed: (factoryName: string) =>
      `${factoryName} confirmed they want to work on your project. Now collecting sample cost, bulk price, and lead time. I will be back with the full quote shortly.`,

    supplierPassed: () =>
      `The supplier passed on the project. I am already researching the next match and will be back with a new pick soon.`,

    supplierCarveOut: (factoryName: string, missingPart: string) =>
      `${factoryName} confirmed for the main project but does not produce ${missingPart}. I will source that part separately so you stay with one main supplier for everything else.`,

    questionForBuyer: (question: string, reason: string) =>
      `Quick question for your project. The supplier is asking ${question}. I want your call on this one because ${reason}. What should I tell them?`,

    dailyDigest: (items: string[]) =>
      `Morning. A few things from yesterday for your project:\n${items.map((it, i) => `${i + 1}. ${it}`).join('\n')}\nNothing urgent, just let me know when you have a minute.`,

    quoteSummary: (factoryName: string, sampleCost: string, bulkPrice: string, qty: number, leadTime: number) =>
      `All info in for ${factoryName}. Sample ${sampleCost}. Bulk at ${qty} units ${bulkPrice} per unit. Lead time ${leadTime} days. Want to proceed with sample, push back on price, or look at alternatives?`,

    paymentRequest: (factoryName: string, sampleCost: number, commission: number, paymentLink: string) =>
      `Sample cost from ${factoryName} is ${sampleCost} euros. Airsup commission is ${commission} euros (7 percent of sample). Total ${sampleCost + commission} euros. Pay here: ${paymentLink}. Once paid I release ${factoryName} direct contact and step back so you can work with them directly.`,

    handover: (factoryName: string, contact: string) =>
      `Sample payment confirmed. Here is ${factoryName} direct contact: ${contact}. Full project history and notes attached. From here you are talking to them directly. I am still here if you need me on the next project.`,

    statusCheck: (stage: string, supplierStatus: string, lastUpdate: string, nextStep: string) =>
      `Status for your project. Stage ${stage}. Supplier ${supplierStatus}. Last update ${lastUpdate}. Next step ${nextStep}.`,
  },

  supplier: {
    signup: () =>
      `Hi, welcome to Airsup. Your factory profile is live. I will reach out as soon as there is a project that matches what you produce.`,

    outreach: (buyerName: string, projectBrief: string) =>
      `Hi, Supi here. ${buyerName} wants to work with you on a new project. Project requirements: ${projectBrief}. Please reply within 24 hours with Yes if you want to take the project, No if it is not a fit, or your question if anything needs clarification before deciding.`,

    askForQuote: (qty: number) =>
      `Great. To brief the buyer I need three things: sample cost, bulk price at ${qty} units, and lead time. Please send all three when ready.`,

    buyerAnswerRelay: (answer: string) =>
      `Update from the buyer on your question. ${answer}. Let me know if anything else is open.`,

    handover: (buyerName: string, contact: string) =>
      `${buyerName} will now take over communication with you directly. Their contact: ${contact}. Thanks for working with us through Airsup.`,
  },
};
