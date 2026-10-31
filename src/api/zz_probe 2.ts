import command from "../extract";

export default async function main(_request: Request) {
    const call = async (body: unknown) => {
        const res = await command(new Request("http://local/", { method: "POST", body: JSON.stringify(body) }));
        return JSON.stringify(res);
    };
    return Response.json({
        spec: await call({
            input_text:
                '{"text": "Invoice INV-42 from Globex. Total due $99.", "concepts": [{"type": "string", "name": "invoice_id", "description": "the invoice id"}]}',
        }),
        garbage: (await call({ input_text: "not json at all" })).slice(0, 120),
        attached_file: (await call({
            input_text: '{"concepts": [{"type": "string", "name": "invoice_id", "description": "the invoice id"}]}',
            context_files: ["/Users/bradhallett/.enconvo/workspace/agent-main/sessions/P8xn_wgSxTTI3ilwrgpQ/sample.docx"],
        })).slice(0, 160),
    });
}
