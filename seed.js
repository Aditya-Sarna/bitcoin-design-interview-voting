import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { seedDatabase } from "./seed-lib.js";
import { CATEGORIES, QUESTIONS } from "./seed-data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "voting.db");

seedDatabase(dbPath);

console.log(`Seeded ${QUESTIONS.length} questions across ${CATEGORIES.length} categories.`);
console.log(`Database: ${dbPath}`);
