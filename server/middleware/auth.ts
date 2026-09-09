import { Request, Response, NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    user?: { username: string };
  }
}

export interface AuthenticatedRequest extends Request {
  user?: { username: string };
}

/** Every API route is behind this — the app has exactly one account. */
export const requireAuth = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  req.user = req.session.user;
  next();
};
