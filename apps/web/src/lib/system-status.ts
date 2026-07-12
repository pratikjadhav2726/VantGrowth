const API_BASE =
  process.env.GROWTHOS_API_BASE_URL ??
  process.env.NEXT_PUBLIC_GROWTHOS_API_BASE_URL ??
  "http://localhost:3000";

export interface SystemStatus {
  paperclip: {
    required: boolean;
    connected: boolean;
    status: "connected" | "required_but_disconnected" | "optional_disconnected";
  };
}

export const getSystemStatus = async (): Promise<SystemStatus | null> => {
  try {
    const res = await fetch(`${API_BASE}/v1/system/status`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as SystemStatus;
  } catch {
    return null;
  }
};
