import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getAdminUser, writeAuditLog } from "../lib/admin";

const router: IRouter = Router();
const MAX_IMAGE_BYTES = 300 * 1024;

type ImageUpload = { buffer: Buffer; mime: "image/jpeg" | "image/webp" } | null;

function validLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "tg:"].includes(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

function parseImage(value: unknown): ImageUpload | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Görsel verisi geçersiz");
  const match = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error("Görsel JPEG veya WebP olmalı");
  const mime = match[1] as "image/jpeg" | "image/webp";
  const buffer = Buffer.from(match[2]!, "base64");
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw new Error("Görsel 300 KB sınırını aşamaz");
  const validSignature = mime === "image/jpeg"
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9
    : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if (!validSignature) throw new Error("Görsel içeriği ve dosya türü eşleşmiyor");
  return { buffer, mime };
}

function formatAd(row: {
  id: string;
  title: string;
  text: string;
  link_url: string;
  button_text: string;
  image_mime: string | null;
  logo_mime: string | null;
  active: boolean;
  views: string;
  clicks: string;
  created_at: Date;
}) {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    linkUrl: row.link_url,
    buttonText: row.button_text,
    hasImage: Boolean(row.image_mime),
    hasLogo: Boolean(row.logo_mime),
    active: row.active,
    views: Number(row.views),
    clicks: Number(row.clicks),
    createdAt: row.created_at,
  };
}

router.get("/ads", async (_req, res) => {
  const admin = getAdminUser(res);
  try {
    const result = await pool.query<{
      id: string;
      title: string;
      text: string;
      link_url: string;
      button_text: string;
      image_mime: string | null;
      logo_mime: string | null;
      active: boolean;
      views: string;
      clicks: string;
      created_at: Date;
    }>(`
      SELECT id::text, title, text, link_url, button_text, image_mime, logo_mime,
        active, views::text, clicks::text, created_at
      FROM ads ORDER BY created_at DESC
    `);
    await writeAuditLog(admin.id, "admin.ads.view", {});
    res.json({ ads: result.rows.map(formatAd) });
  } catch {
    res.status(500).json({ error: "ads_failed" });
  }
});

router.post("/ads", async (req, res) => {
  const admin = getAdminUser(res);
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const linkUrl = typeof req.body?.linkUrl === "string" ? req.body.linkUrl.trim() : "";
  const buttonText = typeof req.body?.buttonText === "string" ? req.body.buttonText.trim() : "";
  const active = req.body?.active === true;
  let image: ImageUpload | undefined;
  let logo: ImageUpload | undefined;
  try {
    image = parseImage(req.body?.image);
    logo = parseImage(req.body?.logo);
  } catch (caught) {
    res.status(400).json({ error: "ad_image_invalid", message: caught instanceof Error ? caught.message : "Görsel geçersiz" });
    return;
  }
  if (!title || title.length > 100 || text.length > 140 || !linkUrl || !validLink(linkUrl) || buttonText.length > 40) {
    res.status(400).json({ error: "ad_input_invalid", message: "Başlık, 140 karakterlik metin, bağlantı ve buton yazısını kontrol edin" });
    return;
  }

  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO ads (title, text, link_url, button_text, image, image_mime, logo, logo_mime, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) RETURNING id::text`,
      [title, text, linkUrl, buttonText, image?.buffer ?? null, image?.mime ?? null, logo?.buffer ?? null, logo?.mime ?? null, active],
    );
    const id = result.rows[0]?.id;
    await writeAuditLog(admin.id, "admin.ad.create", { adId: id, active });
    res.status(201).json({ ok: true, id });
  } catch {
    res.status(500).json({ error: "ad_create_failed" });
  }
});

router.put("/ads/:id", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "ad_id_invalid" });
    return;
  }

  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const linkUrl = typeof req.body?.linkUrl === "string" ? req.body.linkUrl.trim() : "";
  const buttonText = typeof req.body?.buttonText === "string" ? req.body.buttonText.trim() : "";
  const active = req.body?.active;
  let image: ImageUpload | undefined;
  let logo: ImageUpload | undefined;
  try {
    image = parseImage(req.body?.image);
    logo = parseImage(req.body?.logo);
  } catch (caught) {
    res.status(400).json({ error: "ad_image_invalid", message: caught instanceof Error ? caught.message : "Görsel geçersiz" });
    return;
  }
  if (!title || title.length > 100 || text.length > 140 || !linkUrl || !validLink(linkUrl) || buttonText.length > 40 || typeof active !== "boolean") {
    res.status(400).json({ error: "ad_input_invalid" });
    return;
  }

  try {
    const values: unknown[] = [title, text, linkUrl, buttonText, active, id];
    let query = `UPDATE ads SET title = $1, text = $2, link_url = $3, button_text = $4, active = $5`;
    if (image !== undefined) {
      values.push(image?.buffer ?? null, image?.mime ?? null);
      query += `, image = $${values.length - 1}, image_mime = $${values.length}`;
    }
    if (logo !== undefined) {
      values.push(logo?.buffer ?? null, logo?.mime ?? null);
      query += `, logo = $${values.length - 1}, logo_mime = $${values.length}`;
    }
    query += ` WHERE id = $6`;
    const result = await pool.query(query, values);
    if (!result.rowCount) {
      res.status(404).json({ error: "ad_not_found" });
      return;
    }
    await writeAuditLog(admin.id, "admin.ad.update", { adId: id, active });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "ad_update_failed" });
  }
});

router.delete("/ads/:id", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "ad_id_invalid" });
    return;
  }
  try {
    const result = await pool.query("DELETE FROM ads WHERE id = $1", [id]);
    if (!result.rowCount) {
      res.status(404).json({ error: "ad_not_found" });
      return;
    }
    await writeAuditLog(admin.id, "admin.ad.delete", { adId: id });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "ad_delete_failed" });
  }
});

export default router;
