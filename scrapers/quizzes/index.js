import helpers from "../helpers.js";

async function scrapeQuiz(browser, cookies, dir, sectionName, quiz) {
  helpers.print("NOTE", `QUIZ '${quiz.name}'`, `STARTING SCRAPING`, 1);
  const quizDir = helpers.mkUniqueDir(
    `${dir}/QUIZZES/${sectionName}/${quiz.name}`
  );

  const page = await helpers.newPage(browser, cookies, quiz.url);
  await helpers.capturePdf(page, {
    path: `${quizDir}/QUIZ.pdf`,
    format: "Letter",
  });

  let pDownloads = [];
  try {
    pDownloads = await helpers.searchAndDownload(
      page,
      cookies,
      quizDir,
      "a",
      "?download"
    );

    const externalSelector = JSON.parse(process.env.config).externalSelectors
      ?.quiz;
    pDownloads = pDownloads.concat(
      await helpers.searchAndDownloadExternal(page, cookies, quizDir, externalSelector)
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `QUIZ ${quiz.name}`,
      `COULD NOT SCRAPE ${quiz.name}`,
      1,
      e
    );
  }

  helpers.print("NOTE", `QUIZ '${quiz.name}'`, `DONE SCRAPING`, 1);
  await page.close().catch(() => {});
  return pDownloads;
}

async function getQuizzes(page) {
  const selectors = JSON.parse(process.env.config).selectors.quiz;
  return await helpers.getSections(
    page,
    selectors.sectionSelector,
    selectors.headerSelector,
    selectors.itemSelector
  );
}

async function scrapeQuizzes(browser, cookies, url, dir) {
  await helpers.scrapeSections(
    browser,
    cookies,
    url,
    dir,
    "quiz",
    getQuizzes,
    scrapeQuiz
  );
}

export default scrapeQuizzes;
