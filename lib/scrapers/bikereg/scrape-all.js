// TODO: they don't do a good job with paging, so we need to de-dupe events before writing to file

import { log } from 'console-tools'
import {
  get, partialRight, pipe, uniq, map, take, keyBy, range, first, concat, flatMap, reduce,
  keys, sortBy
} from 'lodash/fp'
// import buildScraper from 'little-scraper'
import buildScraperWithProxy from 'scrapers/utils/scraper-with-proxy.js'
import { writeJsonToFile } from 'file-utils'

const createPagedUrls = ({ year, totalEvents }) => {
  // bikereg by default would only return future events, unless year parameter is provided
  const createUrl = page =>
    `https://www.bikereg.com/api/search?year=${year}&startpage=${page}`

  const pageSize = 100
  const totalPages = Math.floor(totalEvents / pageSize)

  const urlsWithPages = range(1, totalPages + 1)
    .map(pageNo => ({pageNo: pageNo, url: createUrl(pageNo)}))

  return urlsWithPages.map(urlWithPage => ({
    url: urlWithPage.url,
    context: { pageNo: urlWithPage.pageNo }
  }))
}

const parseBikeRegEvents = ({ response, urlWithContext }) => {
  // NOTE: even though it payload has "resultsCount" sometimes that property is returned as 0
    // it's non-deterministic
  if (!response.body) {
    log.fail(`${urlWithContext.url} - no "response.body"`)
  }

  const createResponse = ({status}) => ({ status: status, context: urlWithContext.context })

  try {
    const responseJson = JSON.parse(response.body)
    const getResponseProp = partialRight(get, [responseJson])

    if (getResponseProp('MatchingEvents.length') === 0) {
      log.warn(`${urlWithContext.url} - events not found`)
      log.json(response.body)
      return [{
        data: {},
        ...createResponse({status: 'Error'})
      }]
    }

    log.done(`${urlWithContext.url}`)

    return [{
      data: {
        // non-deterministic, but useful for first request
        totalResultsCount: getResponseProp('ResultCount'),
        resultsCount: getResponseProp('MatchingEvents.length') || 0,
        events: getResponseProp('MatchingEvents')
      },
      ...createResponse({status: 'Success'})
    }]
  } catch (e) {
    log.fail(
      `${urlWithContext.url} - can not parse response body json, got this:`
    )
    log.json(response.body)
    log.error(e)
  }
}

const scrape = buildScraperWithProxy({
  scrapingFunc: parseBikeRegEvents,
  concurrency: 10,
  delay: 500
})

async function runScraping() {
  // const results = await scrape(createUrlsWithPermits({ usacEvents: usac2017Events, year: 2017 }))
  const firstPageResults =
    await scrape([{url: 'https://www.bikereg.com/api/search?year=2017', context: {}}])
  const totalResultsCount = firstPageResults[0].data.totalResultsCount
  log.debug(`Found total ${totalResultsCount} events, fetching...`)

  const restOfTheResults = await scrape(createPagedUrls({
    year: 2017,
    totalEvents: totalResultsCount / 10
  }))

  const getAllEvents = (firstPageResults, restOfTheResults) => concat(
    flatMap(x => x.data.events, firstPageResults),
    flatMap(x => x.data.events, restOfTheResults)
  )
  const allEvents = getAllEvents(firstPageResults, restOfTheResults)

  const sortedEvents = pipe(
    reduce((results, event) => {
      if (results[event.EventId]) {
        log.debug(`Fould event with same id`)

        if (event.EventName !== results[event.EventId].EventName) {
          log.warn(`with non matching names:`)
          log.debug('\t\t' + event.EventName)
          log.debug('\t\t' + results[event.EventId].EventName)
        } else {
          log.debug('skipping...')
        }

        return results
      }

      results[event.EventId] = event
      return results
    }, {}),
    map(x => x), //convert map to array
    sortBy('EventId'),
  )(allEvents)

  // const totalProcessedEvents = keys(eventsMap).length
  //
  // if (totalProcessedEvents !== totalResultsCount) {
  //   log.error('Total processed events does not equal original results count')
  //   log.error(`${totalProcessedEvents} !== ${totalResultsCount}`)
  // }

  // log.json(map(x => x.EventId, sortedEvents))

  writeJsonToFile('../../../data/2017-events.json', sortedEvents)
    .then(file => log.done(`Wrote results to: ${file}`))
}

runScraping()

export default scrape