import { Router, type IRouter, type Response } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/ads/public", async (_req, res) => {
  try {
    const result = await pool.query<{
      id: string;
      title: string;
      text: string;
      link_url: string;
      button_text: string;
      image_mime: string | null;
      logo_mime: string | null;
    }>(`
      SELECT id::text, title, text, link_url, button_text, image_mime, logo_mime
      FROM ads WHERE active = TRUE ORDER BY random() LIMIT 1
    `);
    const ad = result.rows[0];
    if (!ad) {
      res.json({ ad: null });
      return;
    }
    res.json({
      ad: {
        id: ad.id,
        title: ad.title,
        text: ad.text,
        linkUrl: ad.link_url,
        buttonText: ad.button_text,
        imageUrl: ad.image_mime ? `/api/ads/${ad.id}/image` : null,
        logoUrl: ad.logo_mime ? `/api/ads/${ad.id}/logo` : null,
      },
    });
  } catch {
    res.status(500).json({ error: "ad_unavailable" });
  }
});

async function serveImage(id: string, kind: "image" | "logo", res: Response) {
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "ad_id_invalid" });
    return;
  }
  const column = kind === "image" ? "image" : "logo";
  const mimeColumn = kind === "image" ? "image_mime" : "logo_mime";
  try {
    const result = await pool.query<{ buffer: Buffer | null; mime: string | null }>(
      `SELECT ${column} AS buffer, ${mimeColumn} AS mime FROM ads WHERE id = $1`,
      [id],
    );
    const image = result.rows[0];
    if (!image?.buffer || !image.mime) {
      res.status(404).json({ error: "image_not_found" });
      return;
    }
    res.setHeader("Content-Type", image.mime);
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(image.buffer);
  } catch {
    res.status(500).json({ error: "image_unavailable" });
  }
}

router.get("/ads/:id/image", (req, res) => {
  void serveImage(String(req.params.id), "image", res);
});

router.get("/ads/:id/logo", (req, res) => {
  void serveImage(String(req.params.id), "logo", res);
});

router.post("/ads/:id/view", async (req, res) => {
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "ad_id_invalid" });
    return;
  }
  try {
    const result = await pool.query("UPDATE ads SET views = views + 1 WHERE id = $1 AND active = TRUE", [id]);
    if (!result.rowCount) {
      res.status(404).json({ error: "ad_not_found" });
      return;
    }
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "view_count_failed" });
  }
});

router.post("/ads/:id/click", async (req, res) => {
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "ad_id_invalid" });
    return;
  }
  try {
    const result = await pool.query("UPDATE ads SET clicks = clicks + 1 WHERE id = $1 AND active = TRUE", [id]);
    if (!result.rowCount) {
      res.status(404).json({ error: "ad_not_found" });
      return;
    }
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "click_count_failed" });
  }
});

export default router;
