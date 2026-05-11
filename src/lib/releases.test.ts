import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestReleaseNotes, fetchReleaseNotes } from "./releases";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("fetchReleaseNotes", () => {
  it("hits the GitHub releases-by-tag endpoint with a v-prefixed tag", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v1.0.8",
          body: "release body",
          html_url: "https://github.com/im-ian/acorn/releases/tag/v1.0.8",
          published_at: "2026-05-11T07:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const notes = await fetchReleaseNotes("1.0.8");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/im-ian/acorn/releases/tags/v1.0.8",
    );
    expect(notes).toEqual({
      version: "1.0.8",
      body: "release body",
      htmlUrl: "https://github.com/im-ian/acorn/releases/tag/v1.0.8",
      publishedAt: "2026-05-11T07:00:00Z",
    });
  });

  it("does not double-prefix a tag that already starts with v", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v2.0.0",
          body: "",
          html_url: "https://github.com/im-ian/acorn/releases/tag/v2.0.0",
          published_at: "2026-05-12T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    await fetchReleaseNotes("v2.0.0");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/im-ian/acorn/releases/tags/v2.0.0",
    );
  });

  it("returns null on 404 so callers can render an 'unpublished' state", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    const notes = await fetchReleaseNotes("99.0.0");

    expect(notes).toBeNull();
  });

  it("throws on other non-OK responses so the UI can surface the failure", async () => {
    fetchMock.mockResolvedValue(new Response("rate limit", { status: 403 }));

    await expect(fetchReleaseNotes("1.0.8")).rejects.toThrow(/403/);
  });

  it("coerces null body to an empty string for tag fetches", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v1.0.8",
          body: null,
          html_url: "https://github.com/im-ian/acorn/releases/tag/v1.0.8",
          published_at: "2026-05-11T07:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const notes = await fetchReleaseNotes("1.0.8");

    expect(notes?.body).toBe("");
  });
});

describe("fetchLatestReleaseNotes", () => {
  it("hits the /releases/latest endpoint and parses the payload", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v1.0.7",
          body: "latest body",
          html_url: "https://github.com/im-ian/acorn/releases/tag/v1.0.7",
          published_at: "2026-05-11T01:59:13Z",
        }),
        { status: 200 },
      ),
    );

    const notes = await fetchLatestReleaseNotes();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/im-ian/acorn/releases/latest",
    );
    expect(notes).toEqual({
      version: "1.0.7",
      body: "latest body",
      htmlUrl: "https://github.com/im-ian/acorn/releases/tag/v1.0.7",
      publishedAt: "2026-05-11T01:59:13Z",
    });
  });

  it("throws on non-OK responses", async () => {
    fetchMock.mockResolvedValue(new Response("rate limit", { status: 403 }));

    await expect(fetchLatestReleaseNotes()).rejects.toThrow(/403/);
  });
});
