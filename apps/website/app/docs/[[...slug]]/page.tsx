import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypePrettyCode from "rehype-pretty-code";
import { getAllDocSlugs, getDocBySlug } from "@/lib/mdx";
import { extractToc } from "@/lib/toc";
import { docMeta } from "@/lib/docs-nav";
import { rehypePrettyCodeOptions } from "@/lib/rehype-code";
import { mdxComponents } from "@/components/mdx/mdx-components";
import { Toc } from "@/components/docs/toc";
import { DocsPager } from "@/components/docs/pager";
import { DocsBreadcrumb } from "@/components/docs/breadcrumb";

// Fully static: enumerate every doc page at build time.
export const dynamic = "error";
export const dynamicParams = false;

type Params = { slug?: string[] };

export function generateStaticParams(): Params[] {
  // The optional catch-all needs the index represented as an empty slug.
  return getAllDocSlugs().map((slug) => ({ slug: slug.length ? slug : [] }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug = [] } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) return {};
  return {
    title: doc.frontmatter.title,
    description: doc.frontmatter.description,
  };
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const { slug = [] } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) notFound();

  const toc = extractToc(doc.content);
  const meta = docMeta(doc.href);

  return (
    <div className="flex gap-8">
      <article className="min-w-0 flex-1 py-8 lg:max-w-3xl">
        <DocsBreadcrumb group={meta.group} title={doc.frontmatter.title} />
        <header className="mb-6">
          <h1 className="scroll-m-20 text-3xl font-bold tracking-tight sm:text-4xl">
            {doc.frontmatter.title}
          </h1>
          {doc.frontmatter.description ? (
            <p className="mt-2 text-lg text-muted-foreground">
              {doc.frontmatter.description}
            </p>
          ) : null}
        </header>

        <div className="text-[15px]">
          <MDXRemote
            source={doc.content}
            components={mdxComponents}
            options={{
              mdxOptions: {
                remarkPlugins: [remarkGfm],
                rehypePlugins: [
                  rehypeSlug,
                  [rehypePrettyCode, rehypePrettyCodeOptions],
                ],
              },
            }}
          />
        </div>

        <DocsPager prev={meta.prev} next={meta.next} />
      </article>
      <Toc entries={toc} />
    </div>
  );
}
