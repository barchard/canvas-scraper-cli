import scrapeAssignments from "./assignments/index.js";
import scrapeModules from "./modules/index.js";
import scrapeQuizzes from "./quizzes/index.js";
import scrapeVideos from "./videos/index.js";
import scrapeStudyNet from "./studynet/index.js";
import scrapeZoom from "./zoom/index.js";

const scrapers = {
  scrapeAssignments,
  scrapeModules,
  scrapeQuizzes,
  scrapeVideos,
  scrapeStudyNet,
  scrapeZoom,
};

export default scrapers;
