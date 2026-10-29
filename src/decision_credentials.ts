import { ApiKeyCredentials } from "./lib/credentials";

/** The decision model's API key (e.g. a TypeSafe key for Jev), managed through Enconvo's credential store. */
export default async function main(request: Request) {
    return new ApiKeyCredentials(await request.json(), "decision model");
}
