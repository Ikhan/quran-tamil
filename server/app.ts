import express from "express";
import session from "express-session";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config/config.js";
import authRoutes from "./routes/auth.js";
import clipRoutes from "./routes/clips.js";
import coverRoutes from "./routes/cover.js";
import reelRoutes from "./routes/reels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Behind a tunnel/reverse proxy, honour the browser's protocol for cookies.
app.set("trust proxy", 1);

app.use(compression());
// A cover photograph arrives as a data URL inside the JSON body, and base64
// inflates it by a third — a phone photo lands around 6-8MB. The dashboard
// downscales before sending, so this is a backstop rather than the usual path.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: "auto",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

// Revalidate rather than cache: a stale dashboard script wired to fresh markup
// is how a button ends up doing something other than what it says.
app.use(
  "/static",
  express.static(path.join(__dirname, "public"), { maxAge: 0, etag: true })
);

app.use("/auth", authRoutes);
app.use("/api/clips", clipRoutes);
app.use("/api/reels", reelRoutes);
app.use("/api/cover", coverRoutes);

const view = (name: string) => path.join(__dirname, "views", `${name}.html`);

app.get("/", (req, res) => {
  res.sendFile(view(req.session.user ? "dashboard" : "login"));
});

app.get("/login", (_req, res) => res.sendFile(view("login")));

app.get("/dashboard", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  res.sendFile(view("dashboard"));
});

app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    // A body over the limit is the caller's problem and has a fix they can
    // act on; reporting it as "something went wrong" tells them nothing.
    if ((error as { type?: string }).type === "entity.too.large") {
      return res.status(413).json({
        error: "That image is too large. Use one under about 20MB.",
      });
    }

    console.error(error.stack);
    res.status(500).json({ error: "Something went wrong" });
  }
);

export default app;
