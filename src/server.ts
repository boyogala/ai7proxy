import { serve } from "@hono/node-server";
import app from "./main.js";

const port = Number(process.env.PORT || process.env.WEB_PORT || "7749");

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`[ai7proxy] Server is running on http://localhost:${info.port}`);
  }
);
