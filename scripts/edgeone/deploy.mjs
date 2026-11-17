import fs from "node:fs";
import { Makers } from "@edgeone/makers-sdk";

for (const key of ["TENCENT_CLOUD_SECRET_ID", "TENCENT_CLOUD_SECRET_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

const projectId = "makers-0nj1yhtkdumv";
const makers = new Makers({
  credentials: {
    secretId: process.env.TENCENT_CLOUD_SECRET_ID,
    secretKey: process.env.TENCENT_CLOUD_SECRET_KEY,
  },
  zoneId: "zone-3xezk62mta64",
  region: "china",
});

const project = await makers.projects.get({ projectId });
if (project.name !== "flowlet-global" || project.area !== "global") {
  throw new Error("Expected the Flowlet global project including mainland China");
}
if (!fs.existsSync("website/dist/index.html")) {
  throw new Error("Run npm run website:build before deployment");
}

const deployment = await makers.deployments.deploy({
  projectId,
  artifact: { directory: "website/dist" },
  env: "Production",
});
const result = await makers.deployments.wait({
  projectId,
  deploymentId: deployment.deploymentId,
  timeout: 300,
  pollInterval: 5,
});
if (result.status !== "Success") {
  throw new Error(`EdgeOne deployment failed: ${result.status}`);
}
console.log(`EdgeOne deployment ${deployment.deploymentId}: ${result.status}`);
console.log("Site: https://flowlet.snewbie.site/");
