export const HIKIGAI_AGENT_TIMEOUT_MS = 300000;
export const HIKIGAI_BACKEND_URL_DEFAULT = "https://backend.hikigaiplatform.io";

export interface AgentAttachment {
	data_base64: string;
	mime_type: string;
}

export class HikigaiClient {
	private apiKey: string;
	private projectId: string;
	private backendUrl: string;
	private authToken: string | null;
	private readonly defaultTimeoutMs: number;

	constructor(apiKey?: string, projectId?: string, backendUrl?: string) {
		this.apiKey = apiKey || process.env.HIKIGAI_API_KEY || "";
		this.projectId = projectId || process.env.HIKIGAI_PROJECT_ID || "";
		this.backendUrl =
			backendUrl ||
			process.env.HIKIGAI_BASE_URL ||
			process.env.HIKIGAI_BACKEND_URL ||
			HIKIGAI_BACKEND_URL_DEFAULT;
		this.authToken = null;
		this.defaultTimeoutMs = HIKIGAI_AGENT_TIMEOUT_MS;
	}

	private getTimeoutMs(timeoutMs?: number): number {
		if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
			return timeoutMs;
		}

		return this.defaultTimeoutMs;
	}

	private getTimeoutSeconds(timeoutMs?: number): number {
		const resolvedTimeoutMs = this.getTimeoutMs(timeoutMs);
		return Math.min(300, Math.max(5, Math.ceil(resolvedTimeoutMs / 1000)));
	}

	private buildInvokeBody(
		input: unknown,
		timeoutMs?: number,
		attachments?: AgentAttachment[]
	): string {
		const body: Record<string, unknown> = {
			input,
			timeout: this.getTimeoutSeconds(timeoutMs),
		};
		if (attachments?.length) {
			body.attachments = attachments;
		}
		return JSON.stringify(body);
	}

	private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
		const resolvedTimeoutMs = this.getTimeoutMs(timeoutMs);
		const controller = new AbortController();
		const parentSignal = init.signal;

		const onAbort = () => controller.abort();
		if (parentSignal) {
			if (parentSignal.aborted) {
				controller.abort();
			} else {
				parentSignal.addEventListener("abort", onAbort, { once: true });
			}
		}

		const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs);

		try {
			return await fetch(url, {
				...init,
				signal: controller.signal,
			});
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Hikigai request timed out after ${resolvedTimeoutMs}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
			if (parentSignal) {
				parentSignal.removeEventListener("abort", onAbort);
			}
		}
	}

	private async getAuthToken(forceRefresh = false, timeoutMs?: number): Promise<string> {
		if (this.authToken && !forceRefresh) {
			return this.authToken;
		}

		if (!this.apiKey) {
			throw new Error("Missing HIKIGAI_API_KEY");
		}

		const url = `${this.backendUrl}/api/v1/auth/exchange`;
		const response = await this.fetchWithTimeout(
			url,
			{
			method: "POST",
			headers: {
				"X-API-Key": this.apiKey,
			},
			},
			timeoutMs
		);

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Hikigai Auth Token Exchange Failed: ${error}`);
		}

		const data = await response.json();
		const token =
			data?.auth_token ||
			data?.access_token ||
			data?.token ||
			data?.data?.access_token;

		if (!token || typeof token !== "string") {
			throw new Error("Hikigai Auth Token Exchange Failed: Token not found in response");
		}

		this.authToken = token;
		return token;
	}

	async ensureAuthToken(forceRefresh = false, timeoutMs?: number) {
		const token = await this.getAuthToken(forceRefresh, timeoutMs);
		return {
			token,
		};
	}

	async invokeAgent(
		agentSlug: string,
		input: unknown,
		timeoutMs?: number,
		attachments?: AgentAttachment[]
	) {
		return this.invokeAgentRaw(agentSlug, input, timeoutMs, attachments);
	}

	private async invokeAgentRaw(
		agentSlug: string,
		input: unknown,
		timeoutMs?: number,
		attachments?: AgentAttachment[]
	) {
		if (!this.projectId) {
			throw new Error("Missing HIKIGAI_PROJECT_ID");
		}

		const url = `${this.backendUrl}/api/v1/agents/${agentSlug}/invoke`;
		let token = await this.getAuthToken(false, timeoutMs);

		const post = (authToken: string) =>
			this.fetchWithTimeout(
				url,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${authToken}`,
						"X-Project-ID": this.projectId,
					},
					body: this.buildInvokeBody(input, timeoutMs, attachments),
				},
				timeoutMs
			);

		let response = await post(token);

		// Session token expired — refresh once and retry.
		if (response.status === 401) {
			token = await this.getAuthToken(true, timeoutMs);
			response = await post(token);
		}

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Hikigai Agent Invocation Failed: ${error}`);
		}

		return await response.json();
	}
}

export const hikigai = new HikigaiClient();
