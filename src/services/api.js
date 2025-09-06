import axios from 'axios';
import { config } from '../config.js';

function resolveBaseURL() {
  if (config.LARAVEL_BASE_URL) {
    return config.LARAVEL_BASE_URL.replace(/\/$/, '') + '/api'; // e.g., http://host + /api
  }
  return null;
}

function buildAxiosConfig(endpoint, method, headers, body, isGet) {
  const baseURL = resolveBaseURL();
  const axiosConfig = {
    method,
    url: endpoint,
    baseURL,
    headers,
    timeout: 15000,
  };
  if (isGet) {
    axiosConfig.params = body;
  } else {
    axiosConfig.data = body;
  }
  return axiosConfig;
}

export async function callLaravelAPI(endpoint, chatId, method = 'POST', body = {}, { session } = {}) {
  const baseURL = resolveBaseURL();
  if (!baseURL) {
    return { error: 'API not configured' };
  }

  const isGet = method.toUpperCase() === 'GET';

  // Base headers for API behavior
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };

  // Prefer per-user access token (Sanctum), else fallback to bot Bearer key
  const userToken = session?.auth?.accessToken;
  if (userToken) {
    headers['Authorization'] = `Bearer ${userToken}`;
  } else if (config.LARAVEL_BOT_API_KEY) {
    headers['Authorization'] = `Bearer ${config.LARAVEL_BOT_API_KEY}`;
  }

  // Always include chat identifier in payload
  const payload = { telegram_chat_id: chatId, ...body };

  try {
    const axiosConfig = buildAxiosConfig(endpoint, method, headers, payload, isGet);
    // Lightweight diagnostics (no sensitive values)
    // console.log('[API] request', { baseURL: axiosConfig.baseURL, url: axiosConfig.url, hasUserToken: Boolean(userToken) });
    const resp = await axios(axiosConfig);
    return resp.data;
  } catch (err) {
    if (err.response) {
      const { status, data } = err.response;
      return { error: data?.message || data?.error || `API error ${status}` };
    }
    if (err.request) {
      return { error: 'Network error: no response from API' };
    }
    return { error: err.message || 'Unexpected error' };
  }
}
