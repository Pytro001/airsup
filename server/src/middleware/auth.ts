import type { Request, Response, NextFunction } from "express";
import { supabaseAnon } from "../services/supabase.js";

export interface AuthRequest extends Request {
  userId?: string;
  jwt?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }
  const token = header.slice(7);
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  req.userId = data.user.id;
  req.jwt = token;
  next();
}
