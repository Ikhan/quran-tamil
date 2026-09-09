import "dotenv/config";
import app from "./app.js";
import { config } from "./config/config.js";
import { coverage } from "./services/timings.js";

const indexed = await coverage();

app.listen(config.port, config.host, () => {
  console.log(`\n📖 Quran Tamil server running on:`);
  console.log(`   💻 Local:   http://localhost:${config.port}`);
  console.log(`\n   📥 Output:  ${config.paths.output}`);
  console.log(`   🔊 Indexed: ${indexed.length}/114 surahs`);
  if (indexed.length < 114) {
    console.log(`   ⏳ Remaining surahs: npm run align\n`);
  } else {
    console.log("");
  }
});
