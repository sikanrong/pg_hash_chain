PGHC
====

###(Postgres HashChain)

This project is meant to be an exploration of 
global-scale distributed systems. As such, it 
seeks to illustrate common problems with such
deployments, as well as their associated 
solutions.

Specifically, this project examines fundamental
concepts around distributed systems such as:

1. Consensus
2. Total-order Broadcast
3. Preservation of Causality

####Cluster Configuration

#####Database nodes
This project uses Docker and Kubernetes to 
deploy a cluster of Postgres databases in a
configuration one might expect to see in a 
typical global-scale deployment.

We imagine that we have several different data 
centers in geographically distinct locations. 
Each datacenter contains a single master 
database node, and several WAL (write-ahead log)
replica nodes. The master node is the only 
node that accepts **WRITE** queries, while the
replicas only serve **READ** queries.

The master nodes communicate with eachother via
BDR (Bi-Directional Replication). Meaning, the
overall setup is a multi-master database architecture,
with all the inherent problems that one might 
expect to encounter given such a design.

#####API Nodes
The cluster also includes a simple API written in
NodeJS. The purpose of the PGHC API is to 
express an application that naturally depends on 
causality. 

This is specifically tricky in a distributed system, as each
master-node will be _concurrently_ accepting writes, 
meaning that each master-node is generally unaware of
the updates happening on another master-node until
some time _after_ those remote transactions are committed,
and the remote database responds with an OK status.

Since we need to ensure that causality is preserved,
our goal is to ensure that data isn't written to the 
database in an order that doesn't make sense.

For example, on Facebook this might look like the 
response to a comment being written to the database
before the original comment being responded to.
We then risk the conversation being displayed 
out-of-order.

In PGHC the design of the application is simple: 
the database has a single "chain" table, with three columns. 
A "hash" column, a "zk_id" column, and a 
"node_id" column. For each entry in the table, 
an MD5 hash is generated from:

1. The current zk_id (a strictly-increasing sequence number)
2. The current node_id (the name of the database node accepting the write request)
3. The "hash" column from the most current entry in the "chain" table, according to the "zk_id".

Because the current write operation depends on
previous write operations, this application depends
on the preservation of causality to function properly. 
At any point, we should be able to get the last _X_ entries
in the "chain" table sorted by the zk_id, and use
the MD5 algorithm to verify that causality has been
correctly preserved at each stage.

#####Apache Zookeeper
Specifically what is needed to preserve causality
in a distributed system is _"Total-Order Broadcast"_. 
Meaning, our application should be smart enough 
to include a strictly-increasing index number for
each new write operation. This strictly-increasing
number must be backed by _consensus_, meaning that 
all of our data-centers need to agree on the next
sequence number before the application is allowed
to see it.

For this, I use _Apache Zookeeper_, a tool specifically
geared towards generating consensus between nodes
in geographically disparate data-centers. It's a specialized tool
that assumes very small data-sizes and fast connections
between nodes.

In the PGHC application I use _total-order broadcast_
to enforce actual serial writes to the database. 
Specifically: a given master node will receive a 
new write request for the database, and will actually 
wait until it receives all preceding distributed writes
(according to the _total-order broadcast_) before proceeding
to write the new value. Hence, we use the _TOB_ to 
preserve causality in this way.