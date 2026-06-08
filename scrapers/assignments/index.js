import fs from "fs";
import helpers from "../helpers.js";
import aHelpers from "./helpers.js";

async function scrapeAssignment(
  browser,
  cookies,
  dir,
  sectionName,
  assignment
) {
  helpers.print(
    "NOTE",
    `ASSIGNMENT '${assignment.name}'`,
    `STARTING SCRAPING`,
    1
  );
  // create assignment directory and open page
  const ASSIGNMENT_PATH = `${dir}/ASSIGNMENTS/${sectionName}/${assignment.name} (${assignment.grade})`;
  fs.mkdirSync(ASSIGNMENT_PATH);
  const page = await helpers.newPage(browser, cookies, assignment.url);

  // scrape comments
  try {
    await aHelpers.scrapeComments(page, ASSIGNMENT_PATH);
  } catch (e) {
    helpers.print(
      "ERROR",
      `ASSIGNMENT '${assignment.name}'`,
      `COULD NOT SCRAPE COMMENTS`,
      2,
      e
    );
  }

  // scrape description
  let problematic = [];
  try {
    problematic = problematic.concat(
      await aHelpers.scrapeDescription(
        page,
        cookies,
        `${ASSIGNMENT_PATH}/ASSIGNMENT`
      )
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `ASSIGNMENT '${assignment.name}'`,
      `COULD NOT SCRAPE DESCRIPTION`,
      2,
      e
    );
  }

  // scrape submissions
  try {
    problematic = problematic.concat(
      await aHelpers.scrapeSubmission(page, cookies, ASSIGNMENT_PATH)
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `ASSIGNMENT '${assignment.name}'`,
      `COULD NOT SCRAPE SUBMISSIONS`,
      2,
      e
    );
  }

  // print warnings if any files could not be downloaded
  if (problematic.length > 0) {
    helpers.print(
      "WARNING",
      `ASSIGNMENT '${assignment.name}'`,
      `COULD NOT DOWNLOAD THE FOLLOWING...`,
      1
    );
    for (let file of problematic) console.log(`    ${file}`);
  }

  helpers.print("NOTE", `ASSIGNMENT '${assignment.name}'`, `DONE SCRAPING`, 1);
  page.close();
  return problematic;
}

async function getAssignments(page) {
  const selectors = JSON.parse(process.env.config).selectors.assignment;
  return await helpers.getSections(
    page,
    selectors.sectionSelector,
    selectors.headerSelector,
    selectors.itemSelector
  );
}

async function scrapeAssignments(browser, cookies, url, dir) {
  await helpers.scrapeSections(
    browser,
    cookies,
    url,
    dir,
    "assignment",
    getAssignments,
    scrapeAssignment
  );
}

export default scrapeAssignments;
