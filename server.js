const express = require("express");
require("dotenv").config();
const axios = require("axios");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const fs = require("fs");

const app = express();

app.use(express.json());

// =====================
// 🏠 Health Check
// =====================
app.get("/", (req, res) => {
  res.send("🚀 Hauloff AI API is running");
});

// =====================
// 📦 CREATE ORDER
// =====================
app.post("/create-order", (req, res) => {
  console.log("🔍 FULL BODY RECEIVED:", JSON.stringify(req.body, null, 2));

  try {
    const order = req.body;

    // Required fields validation
    const requiredFields = [
      "customer_name",
      "phone",
      "address",
      "dumpster_size",
      "scheduled_date",
      "operation_type",
    ];
    for (const field of requiredFields) {
      if (!order[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Conditional validation for swap
    if (order.operation_type === "swap" && !order.previous_order_id) {
      throw new Error("previous_order_id is required for swap operation");
    }

    let scheduled_date = order.scheduled_date;
    let rental_days = order.rental_days || 7;
    let company_name = order.company_name || "Individual";

    const orderId = "HOF-" + Math.floor(Math.random() * 9000000000 + 1000000000);

    let aiResponse = "";
    if (order.operation_type === "swap") {
      aiResponse = `Swap confirmed! Your swap order ID is ${orderId}. We will swap your dumpster on ${scheduled_date}. Reference previous order: ${order.previous_order_id}. Thank you!`;
    } else if (order.operation_type === "pickup") {
      aiResponse = `Pickup confirmed! Your pickup order ID is ${orderId}. We will pick up your dumpster on ${scheduled_date}. Thank you!`;
    } else {
      aiResponse = `Order confirmed! Your order ID is ${orderId}. Your ${order.dumpster_size} dumpster will be delivered on ${scheduled_date} for ${rental_days} days. A Hauloff representative will call you to confirm. Thank you for choosing Hauloff!`;
    }

    res.json({
      success: true,
      order_id: orderId,
      message: aiResponse,
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      message: `Sorry, I couldn't create your order. ${error.message}. Please call us at 1-888-828-1168.`,
    });
  }
});

// =====================
// 📆 CHECK AVAILABILITY (ASYNC VERSION - CORRECTED)
// =====================
app.post("/check-availability", async (req, res) => {
  const { dumpster_size, requested_date, address } = req.body;
  const call_control_id = req.headers["x-telnyx-call-control-id"];

  console.log("🔍 Async availability check request:", {
    dumpster_size,
    requested_date,
    address,
  });
  console.log("📞 Call Control ID:", call_control_id);

  // Immediate 200 response
  res.status(200).send();

  // Process in background
  setTimeout(async () => {
    try {
      const day = new Date(requested_date).getDate();
      const isAvailable = day % 2 === 0;

      let resultMessage = "";
      if (isAvailable) {
        resultMessage = `Great news! The ${dumpster_size} dumpster is available on ${requested_date}. Shall I go ahead and book this for you?`;
      } else {
        resultMessage = `I'm sorry, the ${dumpster_size} dumpster is NOT available on ${requested_date}. Please choose a different date.`;
      }

      await addMessageToConversation(call_control_id, resultMessage);
    } catch (error) {
      console.error("❌ Availability check error:", error);
      await addMessageToConversation(
        call_control_id,
        "I'm sorry, I'm having trouble checking availability right now. Please try again later.",
      );
    }
  }, 2000);
});

// =====================
// 🔄 SCHEDULE SWAP
// =====================
app.post("/schedule-swap", async (req, res) => {
  const { order_id, swap_date } = req.body;
  const call_control_id = req.headers["x-telnyx-call-control-id"];

  console.log("🔄 Swap request:", { order_id, swap_date });

  res.status(200).send();

  setTimeout(async () => {
    try {
      let db = JSON.parse(fs.readFileSync("db.json", "utf8"));
      const originalOrderIndex = db.orders.findIndex(
        (order) => order.id === order_id,
      );

      if (originalOrderIndex === -1) {
        async function addMessageToConversation(call_control_id, message) {
          if (!call_control_id) {
            console.error("❌ Cannot add message: No call_control_id provided");
            return;
          }

          const url = `https://api.telnyx.com/v2/calls/${call_control_id}/actions/ai_assistant_add_messages`;
          const payload = {
            messages: [
              {
                role: "tool_response", // 🔥 এই পরিবর্তনটি গুরুত্বপূর্ণ
                content: message,
              },
            ],
          };

          try {
            await axios.post(url, payload, {
              headers: {
                Authorization: `Bearer ${TELNYX_API_KEY}`,
                "Content-Type": "application/json",
              },
            });
            console.log("✅ Tool response sent to AI successfully:", message);
          } catch (error) {
            console.error(
              "❌ Failed to send tool response:",
              error.response?.data || error.message,
            );
          }
        }
        return;
      }
      // update
      // Update original order
      db.orders[originalOrderIndex].swap_requested = true;
      db.orders[originalOrderIndex].swap_scheduled_date = swap_date;
      db.orders[originalOrderIndex].status = "swap_scheduled";

      // Create new swap order
      const newOrder = {
        ...db.orders[originalOrderIndex],
        id: "SWP-" + Date.now(),
        parent_order_id: order_id,
        status: "pending",
        created_at: new Date().toISOString(),
        scheduled_date: swap_date,
      };
      delete newOrder.swap_requested;
      delete newOrder.swap_scheduled_date;

      db.orders.push(newOrder);
      fs.writeFileSync("db.json", JSON.stringify(db, null, 2));

      await addMessageToConversation(
        call_control_id,
        `Perfect! I've scheduled a swap for your dumpster on ${swap_date}. Your new swap order ID is ${newOrder.id}. Our team will come to pick up the old one and drop off a new one on that day. Thank you!`,
      );
    } catch (error) {
      console.error("❌ Swap error:", error);
      await addMessageToConversation(
        call_control_id,
        "Sorry, I couldn't process your swap request. Please call our support line.",
      );
    }
  }, 2000);
});

// =====================
// 🛠️ HELPER FUNCTIONS
// =====================

function getNextAvailableDate(db, dumpster_size, afterDate) {
  // afterDate থেকে শুরু করুন (যেদিন গ্রাহক চেয়েছে)
  const startDate = new Date(afterDate);

  // নিশ্চিত করুন যে startDate সঠিক তারিখ
  if (isNaN(startDate.getTime())) {
    console.error("Invalid afterDate:", afterDate);
    // fallback: আগামীকাল
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split("T")[0];
  }

  // যেদিন চেয়েছে, তার পরের দিন থেকে শুরু করুন
  startDate.setDate(startDate.getDate() + 1);

  // আগামী 30 দিন চেক করুন
  for (let i = 0; i < 30; i++) {
    const checkDate = new Date(startDate);
    checkDate.setDate(checkDate.getDate() + i);
    const dateString = checkDate.toISOString().split("T")[0];

    // এই তারিখে এই সাইজের কোনো কনফ্লিক্টিং অর্ডার আছে কিনা
    const hasConflict = db.orders.some(
      (order) =>
        order.scheduled_date === dateString &&
        order.dumpster_size === dumpster_size &&
        order.status !== "completed",
    );

    if (!hasConflict) {
      return dateString;
    }
  }

  // 30 দিনের মধ্যে না পেলে 30 দিন পরের তারিখ
  const nextMonth = new Date(startDate);
  nextMonth.setDate(startDate.getDate() + 30);
  return nextMonth.toISOString().split("T")[0];
}

async function addMessageToConversation(call_control_id, message) {
  if (!call_control_id) {
    console.error("❌ Cannot add message: No call_control_id provided");
    return;
  }

  const url = `https://api.telnyx.com/v2/calls/${call_control_id}/actions/ai_assistant_add_messages`;
  const payload = {
    messages: [
      {
        role: "system",
        content: message,
      },
    ],
  };

  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    console.log("✅ Message added to conversation successfully:", message);
  } catch (error) {
    console.error(
      "❌ Failed to add message to conversation:",
      error.response?.data || error.message,
    );
  }
}

// =====================
// 📦 GET ALL ORDERS (Admin testing)
// =====================
app.get("/orders", (req, res) => {
  const db = JSON.parse(fs.readFileSync("db.json", "utf8"));
  res.json(db.orders);
});

// =====================
// 🚀 START SERVER
// =====================
app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
