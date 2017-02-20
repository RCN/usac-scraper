import moment from 'moment'
import _ from 'lodash'
import Bluebird from 'bluebird'
import buildRequest from 'build-request'
const request = buildRequest({useCookies: false})

import {appendJsonToFile, writeJsonToFile} from 'file-utils'
import log from './console-tools'
// Bluebird.longStackTraces() //Long stack traces imply a substantial performance penalty, around 4-5x for throughput and 0.5x for latency.

const TIME_STAMP = moment().format('x_MMM-DD-YYYY_hh-mmA')

const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

//makes  a request with random user agent property every time to workaround some smart scraper blocking websites
const requestWithRotatingUserAgent = (url) => {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2227.1 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2227.0 Safari/537.36',
    // 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', //google bot
    'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:40.0) Gecko/20100101 Firefox/40.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10; rv:33.0) Gecko/20100101 Firefox/33.0',
    'Mozilla/5.0 (X11; OpenBSD amd64; rv:28.0) Gecko/20100101 Firefox/28.0',
    'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; AS; rv:11.0) like Gecko',
    'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 7.0; InfoPath.3; .NET CLR 3.1.40767; Trident/6.0; en-IN)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_3) AppleWebKit/537.75.14 (KHTML, like Gecko) Version/7.0.3 Safari/7046A194A',
  ]
  const options = {
    url: url,
    headers: {
      'User-Agent': userAgents[rnd(0, userAgents.length - 1)],
      //'Proxy-Authorization': 'Basic ' + new Buffer('restuta8@gmail.com:<pwd>').toString('base64')
    },
    //proxy mesh proxies
    // proxy: 'http://open.proxymesh.com:31280',
    // proxy: 'http://au.proxymesh.com:31280',      //all blocked
    // proxy: 'http://us-ca.proxymesh.com:31280',   //all blocked?
    // proxy: 'http://us-ny.proxymesh.com:31280',   //all blocked?
    // proxy: 'http://us-il.proxymesh.com:31280',   //all blocked?

    // proxy: 'http://us-dc.proxymesh.com:31280',    //fast, some blocked
    // proxy: 'http://us-fl.proxymesh.com:31280',    //fast, not blocked
    // proxy: 'http://us.proxymesh.com:31280',      //fast, not blocked
    // proxy: 'http://uk.proxymesh.com:31280',      //fast, not blocked
    // proxy: 'http://ch.proxymesh.com:31280',      //fast, not blocked
    // proxy: 'http://de.proxymesh.com:31280',      //fast, not blocked
    // proxy: 'http://nl.proxymesh.com:31280',      //fast, not blocked
    // proxy: 'http://sg.proxymesh.com:31280',      //slow, not blocked

  }

  return request(url, options)
}

const retry = (funcToRetry, {max = 10, backoff = 100, context}) => {
  return new Bluebird.Promise((resolve, reject) => {
    const attempt = (attemptNo) => {
      if (attemptNo > 1) {
        log.warn(`#${context.context.licenceNo} - retrying, attempt ${attemptNo}/${max}`)
      }

      funcToRetry(attemptNo)
        .then(resolve)
        .catch((err) => {
          if (attemptNo >= max) {
            log.fail(`${context.url} Failed after ${max} attempts :(`)
            return reject(err)
          }
          setTimeout(() => attempt(attemptNo + 1), backoff)
        })
    }
    attempt(1)
  })
}

/* returns a Scraping Function that accept an array of objects representing urls to scrape with
 whatever useful context you can think of created while building them and returns array with scraped results
 event if it's just one url it must be an array, [ 'url' ]. Object has a shape of:
 {
  url: string
  context: object
 }

 Here is why it's useful, think about a situation when you create URL's to scrape and then your scraping func would accept
 results and also would need to understand some context, like "what URL parameters this data was scraped with?".
 Whithout concept of the context you would end up parsing url that you just crated, so why to go through troubles if
 special object can be created as well at the same time as your URLs.
 e.g.
 Say I scraped cat's name and color from the following URL: http://cats.cool/888 where 888 is id of the cat,
 if page HTML doesn't contain cat's id you would have to extract it from the URL, while with context you would created
 given url like so:

 const catId = 888
 const urlToScrape = {
  url: `http://cats.cool/${catId}`,
  context: {
    catId: catId
  }
}

 and then in your scraping func just:

 scrapingFunc(html, urlWithContext) {

   const cat = {
     id: urlWithContext.context.catId, //
     name: scrapeNameFrom(html),
     color: scrapeColorFrom(html),
   }
   return cat
 }
*/

// returns a function ready to be run to start scraping and writing results into cache
// function accepts an array of of urls to scrape and would follow given settings
const buildScraper = ({
  scrapingFunc = (() => []),
  //default pessimistic delat between scraping function calls
  delay = 5000,
  randomizeDelay = true, //would randomize given delay so it's within [x/2, x*2] range
  //1 equal to sequential
  concurrency = 1,
  //default name for file to be used for storing resulting data, this name will also be used for intermediate
  //files created to chache results if "cacheIntermediateResultsToFile" is set to true
  fileName = 'tmp',
  //for long-running scraping processes it's useful to dump results into files so if something fails we don't loose
  //progress
  cacheIntermediateResultsToFile = false,
  writeResultsToFile = false,
}) => {
  return urlsWithContext =>
    Bluebird.map(
      urlsWithContext,
      urlWithContext =>
        retry(() => requestWithRotatingUserAgent(urlWithContext.url), {
          max: 20, backoff: 200, context: urlWithContext
        })
        .delay(randomizeDelay ? rnd(delay / 2, delay * 2) : delay)
        .spread(response => scrapingFunc({
          response: response,
          urlWithContext: urlWithContext
        }))
        // after we got data from every url we can do something, e.g. append it to file as intermediate result
        .then(data => {
          if (cacheIntermediateResultsToFile && data.length > 0) {
            const cacheFileName = `${TIME_STAMP}_${fileName}.json`
            return appendJsonToFile(`data/cache/${cacheFileName}`, data, {spaces: 2})
              .then(() => data)
          } else {
            return data
          }
        }),
      {concurrency: concurrency}
    )
    // combining results into one array
    .reduce((results, currentResults) => {
      if (!_.isArray(results)) {
        throw new Error(`Scraping function must return an array, but it didn't. Instead returned value was: "${currentResults}"`)
      }

      return results.concat(currentResults)
    })
    // write results into file all at once
    .then(results => {
      log.info('Total results: '.grey + results.length.toString().white)

      if (writeResultsToFile) {
        return writeJsonToFile(`data/${fileName}.json`, results, {spaces: 2})
          .then(fileName => log.done(`Saved results to "data/${fileName}"`))
      }

      return results
    })
    .catch(err => {
      if (err.stack) {
        if (err.stack.lines) {
          const newStack = _.map(err.stack.lines(), (line, index) => ('\t\t' + line.trim()))
          .join('\n')

          log.fail(err.name + ', stack:\n ' + newStack)
        } else {
          log.fail(err.name + ', stack:\n ' + err.stack)
        }
      } else {
        log.fail('Something went wrong')
        log.debug(err)
      }
    })
}

export default buildScraper