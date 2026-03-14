const express = require("express");
const { authenticateRequest } = require("../middleware/auth");
const { db } = require("../services/firebase");

const router = express.Router();

/**
 * POST /api/device/register
 *
 * Cihazın deviceId'sini anonim kullanıcının UID'si ile eşleştirir.
 * Uygulama silinip tekrar yüklendiğinde yeni anonim UID oluşur ama
 * deviceId aynı kalır (iOS Keychain). Bu endpoint eski kullanım verisini
 * yeni UID'ye aktarır.
 *
 * Body: { deviceId: string }
 * Header: X-Device-Id: <deviceId>  (middleware tarafından da okunur)
 */
router.post("/device/register", authenticateRequest, async (req, res) => {
  try {
    const { uid, role } = req.user;
    const deviceId = req.body.deviceId || req.headers["x-device-id"];

    if (!deviceId || typeof deviceId !== "string" || deviceId.length < 10) {
      return res.status(400).json({ error: "Valid deviceId is required" });
    }

    const deviceRef = db.collection("devices").doc(deviceId);
    const deviceDoc = await deviceRef.get();

    if (deviceDoc.exists) {
      const existingData = deviceDoc.data();

      // Aynı UID zaten kayıtlı — sadece lastSeenAt güncelle
      if (existingData.currentUid === uid) {
        await deviceRef.update({ lastSeenAt: new Date().toISOString() });
        return res.json({
          status: "already_registered",
          deviceId,
          message: "Device already linked to this user",
        });
      }

      // Farklı UID — cihaz aynı ama yeni anonim oturum açılmış
      // Eski UID'nin kullanım verisini yeni UID'ye taşımaya GEREK YOK
      // çünkü kullanım artık deviceId üzerinden takip ediliyor.
      // Sadece currentUid'yi güncelle.
      const previousUids = existingData.previousUids || [];
      if (existingData.currentUid && !previousUids.includes(existingData.currentUid)) {
        previousUids.push(existingData.currentUid);
      }

      await deviceRef.update({
        currentUid: uid,
        currentRole: role,
        previousUids,
        lastSeenAt: new Date().toISOString(),
      });

      return res.json({
        status: "uid_updated",
        deviceId,
        message: "Device recognized — usage limits preserved",
      });
    }

    // Yeni cihaz kaydı
    await deviceRef.set({
      currentUid: uid,
      currentRole: role,
      previousUids: [],
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });

    return res.json({
      status: "registered",
      deviceId,
      message: "Device registered successfully",
    });
  } catch (err) {
    console.error("Device register error:", err.message);
    res.status(500).json({ error: "Could not register device" });
  }
});

/**
 * GET /api/device/status
 * Cihaz bilgisini döner (debug/admin amaçlı)
 */
router.get("/device/status", authenticateRequest, async (req, res) => {
  try {
    const deviceId = req.headers["x-device-id"];
    if (!deviceId) {
      return res.status(400).json({ error: "X-Device-Id header required" });
    }

    const deviceDoc = await db.collection("devices").doc(deviceId).get();
    if (!deviceDoc.exists) {
      return res.json({ registered: false, deviceId });
    }

    const data = deviceDoc.data();
    return res.json({
      registered: true,
      deviceId,
      currentUid: data.currentUid,
      currentRole: data.currentRole,
      createdAt: data.createdAt,
      lastSeenAt: data.lastSeenAt,
    });
  } catch (err) {
    console.error("Device status error:", err.message);
    res.status(500).json({ error: "Could not fetch device status" });
  }
});

module.exports = router;
