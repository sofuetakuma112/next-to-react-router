import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
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
        </article>
    );
}

export const getServerSideProps: GetServerSideProps<PostPageProps> = async ({ params, res }) => {
    const id = Number(params?.id);
    if (id === 0) return { redirect: { destination: '/posts/1', permanent: false } };
    const post = findPost(id);
    if (!post) return { notFound: true };
    res.setHeader('Cache-Control', 'public, max-age=60');
    return { props: { post } };
};
