let supabaseClient;

function readConfig() {
  const config = window.APP_CONFIG || {};

  return {
    SUPABASE_URL:
      typeof config.SUPABASE_URL === "string" ? config.SUPABASE_URL.trim() : "",
    SUPABASE_PUBLISHABLE_KEY:
      typeof config.SUPABASE_PUBLISHABLE_KEY === "string"
        ? config.SUPABASE_PUBLISHABLE_KEY.trim()
        : ""
  };
}

export function getConfigStatus() {
  const config = readConfig();
  const missing = [];

  if (!config.SUPABASE_URL) {
    missing.push("SUPABASE_URL");
  }

  if (!config.SUPABASE_PUBLISHABLE_KEY) {
    missing.push("SUPABASE_PUBLISHABLE_KEY");
  }

  return {
    config,
    missing,
    ok: missing.length === 0
  };
}

export function createRealtimeClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const { config, ok, missing } = getConfigStatus();

  if (!ok) {
    throw new Error(`Missing Supabase config: ${missing.join(", ")}`);
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    throw new Error("Supabase browser client failed to load.");
  }

  supabaseClient = window.supabase.createClient(
    config.SUPABASE_URL,
    config.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      }
    }
  );

  return supabaseClient;
}

export async function openRoomChannel(room, handlers = {}) {
  const client = createRealtimeClient();
  const channel = client.channel(`room:${room}`);

  Object.entries(handlers).forEach(([eventName, handler]) => {
    channel.on("broadcast", { event: eventName }, async (payload) => {
      await handler(payload?.payload || {}, payload);
    });
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" && !settled) {
        settled = true;
        resolve({ channel, client });
        return;
      }

      if (
        (status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED") &&
        !settled
      ) {
        settled = true;
        reject(new Error(`Realtime channel status: ${status}`));
      }
    });
  });
}

export async function sendBroadcast(channel, event, payload) {
  if (!channel) {
    throw new Error("Cannot send broadcast without an active channel.");
  }

  return channel.send({
    type: "broadcast",
    event,
    payload
  });
}

export async function closeRoomChannel(channel) {
  if (!channel || !supabaseClient) {
    return;
  }

  await supabaseClient.removeChannel(channel);
}
