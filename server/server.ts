import "dotenv/config";
import app, { scheduleMount } from "./app.js";
import { config } from "./config/config.js";
import { coverage } from "./services/timings.js";
import { SCHEDULE_FILE, setUpPosting } from "./posts/posting.js";
import { scheduleRouter } from "./routes/schedule.js";

const indexed = await coverage();

const posting = await setUpPosting();
scheduleMount.use(scheduleRouter(posting));
await posting.start();

app.listen(config.port, config.host, () => {
  console.log(`\n📖 Quran Tamil server running on:`);
  console.log(`   💻 Local:   http://localhost:${config.port}`);
  console.log(`\n   📥 Output:  ${config.paths.output}`);
  console.log(`   🔊 Indexed: ${indexed.length}/114 surahs`);
  console.log(
    posting.posts.backend === "aws"
      ? "   🗓  Queue:   AWS (DynamoDB + EventBridge) — posts go out with this Mac off"
      : `   🗓  Queue:   ${SCHEDULE_FILE} — posts go out while this server runs`
  );
  posting
    .describe()
    .then((line) => console.log(`   📸 Instagram ${line}`))
    .catch(() => undefined);
  if (indexed.length < 114) {
    console.log(`   ⏳ Remaining surahs: npm run align\n`);
  } else {
    console.log("");
  }
});
