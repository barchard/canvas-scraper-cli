import fs from "fs";
import helpers from "../helpers.js";

async function scrapeModule(browser, cookies, dir, sectionName, module) {
  helpers.print("NOTE", `MODULE '${module.name}'`, `STARTING SCRAPING`, 1);
  fs.mkdirSync(`${dir}/MODULES/${sectionName}/${module.name}`);

  const page = await helpers.newPage(browser, cookies, module.url);
  await page.pdf({
    path: `${dir}/MODULES/${sectionName}/${module.name}/MODULE.pdf`,
    format: "Letter",
  });

  const moduleDir = `${dir}/MODULES/${sectionName}/${module.name}`;
  let pDownloads = [];
  try {
    pDownloads = await helpers.searchAndDownload(
      page,
      cookies,
      moduleDir,
      "span > a"
    );

    const externalSelector = JSON.parse(process.env.config).externalSelectors
      ?.module;
    pDownloads = pDownloads.concat(
      await helpers.searchAndDownloadExternal(page, cookies, moduleDir, externalSelector)
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `MODULE ${module.name}`,
      `COULD NOT SCRAPE ${module.name}`,
      1,
      e
    );
  }

  helpers.print("NOTE", `MODULE '${module.name}'`, `DONE SCRAPING`, 1);
  page.close();
  return pDownloads;
}

async function getModules(page) {
  const selectors = JSON.parse(process.env.config).selectors.module;
  return await helpers.getSections(
    page,
    selectors.sectionSelector,
    selectors.headerSelector,
    selectors.itemSelector
  );
}

async function scrapeModules(browser, cookies, url, dir) {
  await helpers.scrapeSections(
    browser,
    cookies,
    url,
    dir,
    "module",
    getModules,
    scrapeModule
  );
}

export default scrapeModules;
