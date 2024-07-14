export interface FeedEntry {
	id: undefined;
	title: string;
	description: string;
	link: string;
	author: undefined;
	published: number;
	created: number;
	category: any[];
	content: undefined;
	enclosures: any[];
	media: Record<string, unknown>;
}
