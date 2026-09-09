import { Router, Request, Response } from "express";
import { appUser } from "../config/config.js";

const router = Router();

router.post("/login", (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};

  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Username and password are required" });
  }

  if (username !== appUser.username || password !== appUser.password) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  req.session.user = { username: appUser.username };
  res.json({ success: true, user: { username: appUser.username } });
});

router.post("/logout", (req: Request, res: Response) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ error: "Could not log out" });
    }
    res.json({ success: true });
  });
});

router.get("/status", (req: Request, res: Response) => {
  res.json(
    req.session.user
      ? { authenticated: true, user: req.session.user }
      : { authenticated: false }
  );
});

export default router;
