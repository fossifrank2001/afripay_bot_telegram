import axios from 'axios';
import { config } from '../config.js';
import FormData from 'form-data';

function resolveBaseURL() {
  //if (config.LARAVEL_API_URL) return config.LARAVEL_API_URL; // e.g., http://host/api
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

  // For all endpoints except simulator, attach Authorization if available
  const isSimulator = endpoint === '/simulator';
  if (!isSimulator) {
    const userToken = session?.auth?.accessToken;
    if (userToken) {
      headers['Authorization'] = `Bearer ${userToken}`;
    } else if (config.LARAVEL_BOT_API_KEY) {
      headers['Authorization'] = `Bearer ${config.LARAVEL_BOT_API_KEY}`;
    }
  } 
 
  // Always include chat identifier in payload
  const payload = { telegram_chat_id: chatId, ...body };

  try {
    const axiosConfig = buildAxiosConfig(endpoint, method, headers, payload, isGet);
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

export async function uploadMultipart(endpoint, chatId, form, { session } = {}) {
  const baseURL = resolveBaseURL();
  if (!baseURL) {
    return { error: 'API not configured' };
  }

  // Append chat id to the form to keep a consistent payload (form-data doesn't support get())
  form.append('telegram_chat_id', String(chatId));

  const headers = {
    ...form.getHeaders(),
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };

  const userToken = session?.auth?.accessToken;
  if (userToken) headers['Authorization'] = `Bearer ${userToken}`;
  else if (config.LARAVEL_BOT_API_KEY) headers['Authorization'] = `Bearer ${config.LARAVEL_BOT_API_KEY}`;

  try {
    const resp = await axios({
      method: 'POST',
      baseURL,
      url: endpoint,
      headers,
      data: form,
      maxContentLength: 10 * 1024 * 1024, // 10 MB client limit
      maxBodyLength: 10 * 1024 * 1024,
      timeout: 20000,
    });
    return resp.data;
  } catch (err) {
    if (err.response) {
      const { status, data } = err.response;
      return { error: data?.message || data?.error || `API error ${status}` };
    }
    if (err.request) return { error: 'Network error: no response from API' };
    return { error: err.message || 'Unexpected error' };
  }
}
