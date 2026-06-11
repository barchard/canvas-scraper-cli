import fs from "fs";
import helpers from "../helpers.js";

const exported = {
  /**
   * Scrapes an assignment description
   * @param {page} page page to scrape from
   * @param {string} dir directory to save to
   * @returns {Promise<Array<string>>} array of problematic files
   */
  async scrapeDescription(page, cookies, dir) {
    // print assignment preview
    fs.mkdirSync(`${dir}`);
    await page.pdf({
      path: `${dir}/ASSIGNMENT.pdf`,
      format: "Letter",
    });

    // gather and download links to files embeded in assignment description
    let problematic = await helpers.searchAndDownload(
      page,
      cookies,
      dir,
      "#assignment_show .description a",
      "download?download"
    );

    // gather and download externally-hosted links (documents, YouTube videos)
    const externalSelector = JSON.parse(process.env.config).externalSelectors
      ?.assignment;
    problematic = problematic.concat(
      await helpers.searchAndDownloadExternal(page, cookies, dir, externalSelector)
    );

    return problematic;
  },

  async scrapeSubmissionDetails(page, cookies, dir) {
    let link = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".content a"))
        .map((a) => a.href)
        .filter((url) => url.includes("/submissions/"))
        .filter((url) => !url.includes("?download"))[0];
    });
    if (!link) return false;

    let newPage = await helpers.newPage(page.browser(), cookies, link);
    try {
      await newPage.pdf({
        path: `${dir}/SUBMISSIONDETAILS.pdf`,
        format: "Letter",
      });
    } finally {
      await newPage.close().catch(() => {});
    }
    return true;
  },

  /**
   * Scrapes an assignment submission
   * @param {page} page page to scrape from
   * @param {Array<object>} cookies cookies to use
   * @param {string} dir directory to save to
   * @returns {Promise<Array<string>>} array of problematic files
   */
  async scrapeSubmission(page, cookies, dir) {
    // print submission details
    try {
      await this.scrapeSubmissionDetails(page, cookies, dir);
    } catch (e) {
      console.log("ERROR: COULD NOT SCRAPE SUBMISSION DETAILS");
    }
    // gather and download links to files submitted by student
    return helpers.searchAndDownload(
      page,
      cookies,
      dir,
      ".content a",
      "?download"
    );
  },

  /**
   * Scrapes an assignment's comments
   * @param {page} page page to scrape from
   * @param {Array<object>} cookies cookies to use
   * @param {string} dir directory to save to
   * @returns {Promise<boolean>} whether or not the comments were scraped successfully
   */
  async scrapeComments(page, dir) {
    let comments = await page.evaluate(() => {
      let comments = document.querySelector(".content > .comments");
      if (!comments) return null;
      return comments.innerText;
    });
    if (!comments) return false;
    await helpers.writeFile(dir, "COMMENTS.txt", comments);
    return true;
  },
};

export default exported;
