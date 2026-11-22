export interface Post {
    id: number;
    title: string;
}

const POSTS: Post[] = [
    { id: 1, title: 'First post' },
    { id: 2, title: 'Second post' },
];

export function findPost(id: number): Post | undefined {
    return POSTS.find((post) => post.id === id);
}

export function allPosts(): Post[] {
    return POSTS;
}
