import { runXReplier } from "./src/jobs/x-automation.js";
runXReplier().then(() => console.log("done")).catch(e => console.error("ERROR:", e));
