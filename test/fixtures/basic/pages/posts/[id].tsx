import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ReactElement } from 'react';
import Layout from '../../components/Layout';
import { findPost, type Post } from '../../lib/posts';

interface PostPageProps {
    post: Post;
}

export default function PostPage({ post }: PostPageProps) {
    const router = useRouter();

    return (
        <article>
            <Head>
                <title>{post.title}</title>
            </Head>
            <h1>{post.title}</h1>
            <p data-testid="id">{router.query.id}</p>
            <p data-testid="path">{router.pathname}</p>
            <button onClick={() => router.push({ pathname: '/about', query: { from: post.id } })}>About</button>
            <button onClick={() => router.back()}>Back</button>
            <Link href="../about">Up to about</Link> <Link href="2">Sibling post</Link>
        </article>
    );
}

// The layout is rendered outside the page's route after the conversion; its relative links still resolve against the page
PostPage.getLayout = (page: ReactElement) => <Layout>{page}</Layout>;

export const getServerSideProps: GetServerSideProps<PostPageProps> = async ({ params, res }) => {
    const id = Number(params?.id);
    if (id === 0) return { redirect: { destination: '/posts/1', permanent: false } };
    const post = findPost(id);
    if (!post) return { notFound: true };
    res.setHeader('Cache-Control', 'public, max-age=60');
    return { props: { post } };
};
