import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config({ path: path.resolve(process.cwd(), ".env.example") });
