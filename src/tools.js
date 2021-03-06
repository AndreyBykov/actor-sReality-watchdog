const Apify = require('apify');
const { SELECTORS, ESTATE_TYPES, OFFER_TYPES } = require('./consts');

const { utils: { log, sleep } } = Apify;

const getAndValidateInput = async () => {
    const input = await Apify.getInput();

    const { location, offerType, type, maxPages, proxyConfiguration, notificationsEmail, priceMin, priceMax, areaMin, areaMax } = input;

    log.info(`Search Location: ${location}`);
    log.info(`Object Type: ${type}`);
    log.info(`Operation Type: ${offerType}`);

    if (!offerType || !type || !location) {
        throw new Error('Check input! Offer type (sale/rent/auction), type (house/apartment/etc) or location are missing');
    }

    const price = {};
    if (priceMin) price.from = priceMin.toString();
    if (priceMax) price.to = priceMax.toString();

    const livingArea = {};
    if (areaMin) livingArea.from = areaMin.toString();
    if (areaMax) livingArea.to = areaMax.toString();

    const subtype = [];
    const inputKeys = Object.keys(input);
    for (const key of inputKeys) {
        if (key.startsWith(input.type) && input[key] === true) {
            subtype.push(key.split(':')[1]);
        }
    }

    return {
        proxyConfiguration,
        sendNotificationTo: notificationsEmail,
        offerType,
        type,
        subtype,
        location,
        price,
        livingArea,
        maxPages,
    };
}

const getSearchUrl = (type) => {
    return [{
        url: ESTATE_TYPES[type].url,
        userData: { label: 'startPage' },
    }];
}

const selectOfferType = async ({ page, offerType }) => {
    await page.click(OFFER_TYPES[offerType].selectors.switcher)
        .catch(err => { throw new Error(`No selector matched: offerType -> ${offerType}`); });
    await sleep(1000);
}

const selectSubtype = async ({ page, subtype, type }) => {
    if (subtype.length > 0) {
        const subtypes = subtype.map(st => ESTATE_TYPES[type].subtypes[st]);
        const $$subtype = await matchNodesByContents(page, SELECTORS.subtype, subtypes)
            .catch(error => {
                log.error(error.message);
                throw Error(`No selector matched: subtype -> ${subtype.join('; ')}`);
            });
        await Promise.all($$subtype.map($node => $node.click()));
    }
}

const setLocation = async ({ page, location }) => {
    await page.type(SELECTORS.location.input, location);
    await page.waitForFunction(selector => document.querySelector(selector), { polling: 'mutation' }, SELECTORS.location.autocomplete);
    await sleep(1000);
    await page.keyboard.press('Enter');
    await sleep(1000);
}

const setOtherParams = async ({ page, price, livingArea }) => {
    if (price && price.from) await page.type(SELECTORS.price.from, price.from, { delay: 100 });
    if (price && price.to) await page.type(SELECTORS.price.to, price.to, { delay: 100 });
    if (livingArea && livingArea.from) await page.type(SELECTORS.area.from, livingArea.from, { delay: 100 });
    if (livingArea && livingArea.to) await page.type(SELECTORS.area.to, livingArea.to, { delay: 100 });
    await page.click('form div.region.distance .line-title');
    await sleep(2000);
}

const loadSearchResults = async ({ page, store, previousData, sendNotificationTo }) => {
    const showResultsButton = await page.evaluate(() => {
        return document.querySelector('.return-cover') && !document.querySelector('.filter__buttons__not-found');
    });

    if (showResultsButton) {
        await Promise.all([
            page.waitForNavigation({ waitUntil: ['load', 'networkidle0'] }),
            page.click(SELECTORS.submit)
        ]);
        await page.waitForSelector('.dir-property-list');
    } else {
        log.info('No search results');
        await store.setValue('currentData', []);
        if (!previousData) {
            log.info('Initial run, no previously found listings. Sending email');
            if (sendNotificationTo) await Apify.call('apify/send-mail', {
                to: sendNotificationTo,
                subject: 'Apify sRelity Listings Monitor - No Listing(s) Found',
                text: 'No listing(s) matching your query found',
            });
        } else {
            if (previousData.length > 0) {
                log.info('Previously found listings were removed. Sending email')
                await store.setValue('previousData', previousData);
                if (sendNotificationTo) await Apify.call('apify/send-mail', {
                    to: sendNotificationTo,
                    subject: 'Apify sRelity Listings Monitor - Listing(s) Removed',
                    text: 'Previously found listing(s):' + '\n' + previousData.join('\n'),
                });
            }
        }
    }

    return showResultsButton;
}

const extractProperties = async ({ page, dataset }) => {
    const listings = await page.evaluate(() => {
        const output = [];
        [...document.querySelectorAll('.dir-property-list > .property')].map((listing) => {
            if (!listing.querySelector('span[class*=tip]')) {
                output.push({ url: listing.querySelector('a').href });
            }
        });
        return output;
    });
    await dataset.pushData(listings);
}

const enqueueNextPage = async ({ page, maxPages, requestQueue }) => {
    const currentPage = await page.evaluate(() => {
        const currentPageSelector = document.querySelector('.paging-item > a.active');
        return currentPageSelector ? Number(currentPageSelector.innerText) : null;
    });
    const nextPageUrl = await page.evaluate(() => {
        const nextPageSelector = document.querySelector('.paging-item > a.paging-next');
        return nextPageSelector ? nextPageSelector.href : null;
    });
    if ((currentPage && maxPages && currentPage < maxPages) || (!maxPages && nextPageUrl)) {
        await requestQueue.addRequest({ url: nextPageUrl, userData: { label: 'searchPage' } });
    }
}

const compareDataAndSendNotification = async ({ store, dataset, previousData, sendNotificationTo }) => {
    const outputItems = await dataset.getData().then(response => response.items);
    const currentData = outputItems.map(entry => entry.url);
    await store.setValue('currentData', currentData);
    log.info(`${currentData.length} matching listing(s) found`)

    if (!previousData) {
        log.info('Initial run, no previously found listings');
        if (sendNotificationTo) {
            log.info('Sending Email');
            await Apify.call('apify/send-mail', {
                to: sendNotificationTo,
                subject: 'Apify sRelity Listings Monitor - Listing(s) Found',
                text: 'Found listing(s):' + '\n' + currentData.join('\n'),
            });
        }
    } else {
        await store.setValue('previousData', previousData);
        if (!(previousData.every(e => currentData.includes(e)) && currentData.every(e => previousData.includes(e)))) {
            log.info('There were some updates');
            if (sendNotificationTo) {
                log.info('Sending Email');
                await Apify.call('apify/send-mail', {
                    to: sendNotificationTo,
                    subject: 'Apify sRelity Listings Monitor - Listing(s) Updated',
                    text: 'Currently found listing(s):' + '\n' + currentData.join('\n') + '\n\n'
                        + 'Previously found listing(s):' + '\n' + previousData.join('\n'),
                });
            }
        } else {
            log.info('No new listing(s) found');
        }
    }
}

const matchNodesByContents = async (page, selector, contents) => {
    contents = Array.isArray(contents) ? contents : [contents];

    const $$nodes = await page.$$(selector);

    const nodes = await Promise.all($$nodes.map(async $node => ({
        node: $node,
        content: await $node.evaluate(node => node.innerText)
    })));

    return nodes
        .filter(node => {
            contents.some(content => {
                return node.content.trim().toLowerCase() === content.trim().toLowerCase();
            });
        })
        .map(node => node.node);
};

module.exports = {
    getAndValidateInput,
    getSearchUrl,
    selectOfferType,
    selectSubtype,
    setLocation,
    setOtherParams,
    loadSearchResults,
    enqueueNextPage,
    extractProperties,
    compareDataAndSendNotification,
};
