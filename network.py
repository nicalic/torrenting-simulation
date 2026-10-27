
import matplotlib.pyplot as plt
import networkx as nx

class TorrentGraph:
    COLOUR = {"seeder": "tab:blue", "client": "tab:green", "peer": "white"}

    def __init__(self, edges):
        self.G = nx.Graph()
        self.G.add_edges_from(edges)
        self.roles = {}
        self.pos = nx.spring_layout(self.G, seed=0)

    def role(self, node):
        return self.roles.get(node, "peer")

    def visualise(self):
        node_colour = [self.COLOUR[self.role(v)] for v in self.G.nodes()]
        nx.draw(self.G, self.pos, node_color=node_colour, edgecolors="black", with_labels=True)
        plt.show()

edges = [
        (0,2), (0,3), (2,4), (3,5),
        (4,1), (5,1), (2,6), (6,1)
]

TG = TorrentGraph(edges)
TG.roles = {0: "seeder", 1: "client"}
TG.visualise()

